/*
 * bash-gate's supervisor: runs a command under ptrace with a seccomp filter that stops every execve and execveat in
 * its process tree, reports each one, and lets it go ahead or fails it with EPERM, as the caller answers.
 *
 *   supervisor <socket> <program> [args...]
 *
 * It connects to the Unix socket, runs the program (looked up in PATH) with the environment it was given, and speaks
 * in records of NUL-terminated fields:
 *
 *   R pid                              the program's process, before it runs
 *   F parent child                     a process (or thread) started another
 *   X pid threads path argc argv...    an exec is about to happen; the caller answers one byte, 'y' or 'n'
 *   E pid former                       an exec happened in pid (from thread `former`, when it wasn't the leader)
 *   Z code signal                      everything exited; the program's exit code, or the signal that ended it
 *   ! message                          the supervisor failed
 *
 * x86_64 Linux only. Other system-call ABIs (i386, x32) can't exec: the filter kills a process that tries.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <unistd.h>

#if !defined(__x86_64__)
#error "bash-gate's supervisor supports x86_64 Linux only"
#endif

#define X32 0x40000000
#define I386_EXECVE 11
#define I386_EXECVEAT 358
/* What the kernel accepts for argv and the strings in it (MAX_ARG_STRLEN), with room to spare. */
#define MAX_ARGS (1 << 20)
#define MAX_STRING (32 * 4096)
#define MAX_PID (1 << 22)

static int sock = -1;

static void fail(const char *what) {
  char message[512];
  int length = snprintf(message, sizeof message, "!%c%s: %s", 0, what, strerror(errno));
  if (sock >= 0 && length > 0) (void)!write(sock, message, (size_t)length + 1);
  fprintf(stderr, "bash-gate supervisor: %s: %s\n", what, strerror(errno));
  exit(125);
}

/* A growing run of NUL-terminated fields. Records are built in one and written whole. */
struct fields {
  char *data;
  size_t used, capacity;
};
static struct fields out, args;

static void put(struct fields *fields, const char *field, size_t length) {
  if (fields->used + length + 1 > fields->capacity) {
    while (fields->used + length + 1 > fields->capacity) fields->capacity = fields->capacity ? fields->capacity * 2 : 4096;
    fields->data = realloc(fields->data, fields->capacity);
    if (!fields->data) fail("realloc");
  }
  memcpy(fields->data + fields->used, field, length);
  fields->data[fields->used + length] = 0;
  fields->used += length + 1;
}

static void put_string(const char *field) { put(&out, field, strlen(field)); }

static void put_number(long long value) {
  char text[32];
  put(&out, text, (size_t)snprintf(text, sizeof text, "%lld", value));
}

static void flush(void) {
  for (size_t done = 0; done < out.used;) {
    ssize_t n = write(sock, out.data + done, out.used - done);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) fail("write");
    done += (size_t)n;
  }
  out.used = 0;
}

static int install_filter(void) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_I386, 7, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_execve, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_TRACE | 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_execveat, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_TRACE | 1),
    /* x32 system calls kill the process. */
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, X32, 3, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, I386_EXECVE, 1, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, I386_EXECVEAT, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {.len = sizeof filter / sizeof filter[0], .filter = filter};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

/*
 * Takes CAP_SYS_PTRACE from the tree, root included; no_new_privs keeps it from coming back. Without it, Yama's
 * ptrace_scope 1 lets a process write only its descendants' memory (/proc/<pid>/mem, process_vm_writev), so a process
 * can't change the arguments of an exec its parent or sibling makes after the check.
 */
static int drop_ptrace(void) {
  /* Without CAP_SETPCAP the bounding set can't change (EPERM): then no_new_privs alone keeps it from coming back. */
  if (prctl(PR_CAPBSET_DROP, CAP_SYS_PTRACE, 0, 0, 0) != 0 && errno != EPERM && errno != EINVAL) return -1;
  struct __user_cap_header_struct header = {.version = _LINUX_CAPABILITY_VERSION_3};
  struct __user_cap_data_struct data[_LINUX_CAPABILITY_U32S_3];
  if (syscall(SYS_capget, &header, data) != 0) return -1;
  unsigned int mask = CAP_TO_MASK(CAP_SYS_PTRACE);
  struct __user_cap_data_struct *word = &data[CAP_TO_INDEX(CAP_SYS_PTRACE)];
  /* Inheritable too: ambient capabilities can't outlive it. */
  word->effective &= ~mask;
  word->permitted &= ~mask;
  word->inheritable &= ~mask;
  return (int)syscall(SYS_capset, &header, data);
}

/* Reads a NUL-terminated string from the tracee into `buffer`; its length, or -1. */
static ssize_t read_string(int mem, unsigned long address, char *buffer, size_t size) {
  size_t length = 0;
  while (length < size) {
    size_t chunk = 4096 - ((address + length) % 4096);
    if (chunk > size - length) chunk = size - length;
    ssize_t n = pread(mem, buffer + length, chunk, (off_t)(address + length));
    if (n <= 0) return -1;
    void *end = memchr(buffer + length, 0, (size_t)n);
    if (end) return (char *)end - buffer;
    length += (size_t)n;
  }
  return -1;
}

static long threads_of(pid_t pid) {
  char path[64], line[256];
  snprintf(path, sizeof path, "/proc/%d/status", pid);
  FILE *status = fopen(path, "r");
  if (!status) return -1;
  long threads = -1;
  while (fgets(line, sizeof line, status))
    if (sscanf(line, "Threads: %ld", &threads) == 1) break;
  fclose(status);
  return threads;
}

static void deny(pid_t pid, struct user_regs_struct *regs) {
  /* A skipped system call returns what the tracer leaves in rax. */
  regs->orig_rax = (unsigned long long)-1;
  regs->rax = (unsigned long long)-EPERM;
  if (ptrace(PTRACE_SETREGS, pid, 0, regs) != 0 && errno != ESRCH) fail("PTRACE_SETREGS");
}

static char string[MAX_STRING + 1];

/* Reports the exec a seccomp stop is about and asks whether it goes ahead; 0 when it doesn't. */
static int ask(pid_t pid, struct user_regs_struct *regs, int at) {
  unsigned long path_address = at ? regs->rsi : regs->rdi;
  unsigned long argv_address = at ? regs->rdx : regs->rsi;
  int dirfd = at ? (int)regs->rdi : AT_FDCWD;
  int flags = at ? (int)regs->r8 : 0;

  char mem_path[64];
  snprintf(mem_path, sizeof mem_path, "/proc/%d/mem", pid);
  int mem = open(mem_path, O_RDONLY | O_CLOEXEC);
  if (mem < 0) return 0;

  /* Anything that can't be read fails the exec: the kernel reads the same memory, and no longer a path. */
  int ok = 1;
  char path[PATH_MAX * 2] = "";
  ssize_t length = read_string(mem, path_address, string, PATH_MAX);
  if (length < 0) ok = 0;
  else if (at && string[0] != '/' && (dirfd != AT_FDCWD || (length == 0 && (flags & AT_EMPTY_PATH)))) {
    char link[64];
    if (dirfd == AT_FDCWD) snprintf(link, sizeof link, "/proc/%d/cwd", pid);
    else snprintf(link, sizeof link, "/proc/%d/fd/%d", pid, dirfd);
    ssize_t n = readlink(link, path, PATH_MAX);
    if (n < 0) ok = 0;
    else {
      path[n] = 0;
      if (length > 0) snprintf(path + n, sizeof path - (size_t)n, "/%s", string);
    }
  } else memcpy(path, string, (size_t)length + 1);

  long argc = 0;
  args.used = 0;
  for (; ok && argv_address; argc++) {
    unsigned long pointer;
    if (argc >= MAX_ARGS ||
        pread(mem, &pointer, sizeof pointer, (off_t)(argv_address + argc * sizeof pointer)) != sizeof pointer) {
      ok = 0;
      break;
    }
    if (!pointer) break;
    length = read_string(mem, pointer, string, MAX_STRING);
    if (length < 0) ok = 0;
    else put(&args, string, (size_t)length);
  }
  close(mem);
  if (!ok) return 0;

  put_string("X");
  put_number(pid);
  put_number(threads_of(pid));
  put_string(path);
  put_number(argc);
  /* The arguments as one field holding their own separators: `put` adds the last one. */
  if (args.used > 0) put(&out, args.data, args.used - 1);
  flush();

  char verdict;
  for (;;) {
    ssize_t n = read(sock, &verdict, 1);
    if (n == 1) break;
    if (n < 0 && errno == EINTR) continue;
    errno = n == 0 ? EPIPE : errno;
    fail("read");
  }
  return verdict == 'y';
}

/* Where each pid is in its life, so a new process runs only once its parent's report of it has gone out. */
enum { UNSEEN, ANNOUNCED, WAITING, RUNNING };
static unsigned char *state;

static void cont(pid_t pid, int signal) {
  if (ptrace(PTRACE_CONT, pid, 0, signal) != 0 && errno != ESRCH) fail("PTRACE_CONT");
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: supervisor <socket> <program> [args...]\n");
    return 2;
  }
  signal(SIGPIPE, SIG_IGN);

  struct sockaddr_un address = {.sun_family = AF_UNIX};
  if (strlen(argv[1]) >= sizeof address.sun_path) {
    errno = ENAMETOOLONG;
    fail("socket path");
  }
  strcpy(address.sun_path, argv[1]);
  sock = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (sock < 0) fail("socket");
  if (connect(sock, (struct sockaddr *)&address, sizeof address) != 0) fail("connect");

  state = calloc(MAX_PID + 1, 1);
  if (!state) fail("calloc");

  pid_t root = fork();
  if (root < 0) fail("fork");
  if (root == 0) {
    if (ptrace(PTRACE_TRACEME, 0, 0, 0) != 0) _exit(126);
    raise(SIGSTOP);
    if (drop_ptrace() != 0 || install_filter() != 0) _exit(126);
    execvp(argv[2], argv + 2);
    _exit(127);
  }

  int status;
  if (waitpid(root, &status, 0) != root || !WIFSTOPPED(status)) fail("waitpid");
  long options = PTRACE_O_TRACESECCOMP | PTRACE_O_TRACEFORK | PTRACE_O_TRACEVFORK | PTRACE_O_TRACECLONE |
                 PTRACE_O_TRACEEXEC | PTRACE_O_EXITKILL;
  if (ptrace(PTRACE_SETOPTIONS, root, 0, options) != 0) fail("PTRACE_SETOPTIONS");
  put_string("R");
  put_number(root);
  flush();
  state[root] = RUNNING;
  cont(root, 0);

  /* The program's own exec, and execvp's tries along PATH, go ahead unasked: the caller chose the program. */
  int started = 0;
  int code = -1, ended_by = 0;
  for (;;) {
    pid_t pid = waitpid(-1, &status, __WALL);
    if (pid < 0) {
      if (errno == EINTR) continue;
      if (errno == ECHILD) break;
      fail("waitpid");
    }
    if (pid > MAX_PID) {
      errno = ERANGE;
      fail("pid");
    }
    if (WIFEXITED(status) || WIFSIGNALED(status)) {
      if (pid == root) {
        code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
        ended_by = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
      }
      state[pid] = UNSEEN;
      continue;
    }
    if (!WIFSTOPPED(status)) continue;

    int signal = WSTOPSIG(status);
    int event = (unsigned)status >> 16;
    if (signal == SIGTRAP && event) {
      unsigned long message = 0;
      if (ptrace(PTRACE_GETEVENTMSG, pid, 0, &message) != 0) {
        if (errno == ESRCH) continue;
        fail("PTRACE_GETEVENTMSG");
      }
      if (event == PTRACE_EVENT_FORK || event == PTRACE_EVENT_VFORK || event == PTRACE_EVENT_CLONE) {
        pid_t child = (pid_t)message;
        if (child <= 0 || child > MAX_PID) {
          errno = ERANGE;
          fail("child pid");
        }
        put_string("F");
        put_number(pid);
        put_number(child);
        flush();
        if (state[child] == WAITING) {
          state[child] = RUNNING;
          cont(child, 0);
        } else state[child] = ANNOUNCED;
      } else if (event == PTRACE_EVENT_SECCOMP) {
        struct user_regs_struct regs;
        if (ptrace(PTRACE_GETREGS, pid, 0, &regs) != 0) {
          if (errno == ESRCH) continue;
          fail("PTRACE_GETREGS");
        }
        if (!(pid == root && !started) && !ask(pid, &regs, message == 1)) deny(pid, &regs);
      } else if (event == PTRACE_EVENT_EXEC) {
        if (pid == root && !started) started = 1;
        else {
          put_string("E");
          put_number(pid);
          put_number((long long)message);
          flush();
        }
        if ((pid_t)message != pid && message <= MAX_PID) state[message] = UNSEEN;
      }
      cont(pid, 0);
      continue;
    }

    if (signal == SIGSTOP && state[pid] != RUNNING) {
      /* A new process's first stop. It waits until its parent's fork event has been reported. */
      if (state[pid] == ANNOUNCED) {
        state[pid] = RUNNING;
        cont(pid, 0);
      } else state[pid] = WAITING;
      continue;
    }

    siginfo_t info;
    if (ptrace(PTRACE_GETSIGINFO, pid, 0, &info) != 0) {
      if (errno == ESRCH) continue;
      /* A group stop (SIGSTOP, SIGTSTP…) without PTRACE_SEIZE: it carries on rather than stopping. */
      cont(pid, 0);
      continue;
    }
    cont(pid, signal);
  }

  put_string("Z");
  put_number(code);
  put_number(ended_by);
  flush();
  return 0;
}
