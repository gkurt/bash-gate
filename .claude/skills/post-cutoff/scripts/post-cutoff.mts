#!/usr/bin/env node
/**
 * Lists git, gh and GitHub changes newer than a model's training cutoff or a date.
 *
 *   node post-cutoff.mts --tool <tool,...> --model <model-id> [--json]
 *   node post-cutoff.mts --tool <tool,...> --date <YYYY-MM[-DD]> [--json]
 *   node post-cutoff.mts --details <id,...> [--json]
 *
 * The first two print an index of entry ids; --details prints the full entries.
 * Runs on Node 22.18+ (type stripping) or Bun, with no dependencies.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

type Entry = {
  id: string;
  date: string;
  version?: string;
  feature: string;
  summary: string;
  check?: string;
  docs: string;
  skill?: string;
};

type Tool = {
  tool: string;
  name: string;
  reviewed: string;
  version?: { command: [string, ...string[]]; pattern: string };
  changelogs: string[];
  entries: Entry[];
};

type Model = { id: string; aliases: string[]; cutoff: string; source: string };

const DATA_DIR = join(import.meta.dirname, '..', 'data');
const DATE_PATTERN = /^\d{4}-\d{2}(-\d{2})?$/;
/** Training data thins out in the months before a cutoff, so the index starts this much earlier. */
const LOOKBACK_MONTHS = 3;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function print(lines: string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_PATTERN.test(value);
}

function isEntry(value: unknown): value is Entry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isDate(value.date) &&
    typeof value.feature === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.docs === 'string'
  );
}

function isTool(value: unknown): value is Tool {
  return (
    isRecord(value) &&
    typeof value.tool === 'string' &&
    typeof value.name === 'string' &&
    isDate(value.reviewed) &&
    Array.isArray(value.changelogs) &&
    Array.isArray(value.entries) &&
    value.entries.every(isEntry)
  );
}

function isModel(value: unknown): value is Model {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    Array.isArray(value.aliases) &&
    isDate(value.cutoff) &&
    typeof value.source === 'string'
  );
}

function isModels(value: unknown): value is { models: Model[] } {
  return isRecord(value) && Array.isArray(value.models) && value.models.every(isModel);
}

function load<T>(file: string, guard: (value: unknown) => value is T): T {
  const value: unknown = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'));
  if (!guard(value)) fail(`Malformed data file: data/${file}`);
  return value;
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/\[.*?\]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function findModel(models: Model[], query: string): Model | undefined {
  const input = normalize(query);
  let best: { model: Model; length: number } | undefined;
  for (const model of models) {
    for (const name of [model.id, ...model.aliases]) {
      const matches = new RegExp(`(^|-)${name}(-|$)`).test(input);
      if (matches && name.length > (best?.length ?? 0)) best = { model, length: name.length };
    }
  }
  return best?.model;
}

/** Month-only dates count as their last day, so a month that overlaps the cutoff is included. */
function entryEnd(date: string): string {
  return date.length === 7 ? `${date}-31` : date;
}

function lookbackStart(cutoff: string): string {
  const [year = 0, month = 1] = cutoff.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1 - LOOKBACK_MONTHS, 1));
  return start.toISOString().slice(0, 10);
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function installedVersion(tool: Tool): string | undefined {
  if (!tool.version) return undefined;
  const [command, ...args] = tool.version.command;
  try {
    const output = execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
    return new RegExp(tool.version.pattern).exec(output)?.[1];
  } catch {
    return undefined;
  }
}

function availability(entry: Entry, installed: string | undefined): boolean | undefined {
  if (!installed || !entry.version) return undefined;
  return compareVersions(installed, entry.version) >= 0;
}

function upgradeNote(tool: Tool, entry: Entry, available: boolean | undefined): string {
  return available === false ? `  [needs ${tool.tool} >= ${entry.version}]` : '';
}

function showDetails(tools: Tool[], ids: string[], json: boolean): void {
  const found = ids.map((id) => {
    const tool = tools.find((t) => t.entries.some((entry) => entry.id === id));
    const entry = tool?.entries.find((e) => e.id === id);
    if (!tool || !entry) fail(`Unknown id "${id}". Ids come from the index: run with --tool and --model or --date.`);
    const installed = installedVersion(tool);
    return { tool, entry, installed, available: availability(entry, installed) };
  });

  if (json) {
    printJson(found.map(({ tool, entry, installed, available }) => ({ ...entry, tool: tool.tool, installed, available })));
    return;
  }

  const lines: string[] = [];
  for (const { tool, entry, installed, available } of found) {
    const release = [`${tool.name}${entry.version ? ` ${entry.version}` : ''}`, entry.date];
    if (installed) release.push(`installed ${installed}`);
    lines.push(`${entry.id}: ${entry.feature}${upgradeNote(tool, entry, available)}`);
    lines.push(`  ${release.join(' · ')}`);
    lines.push(`  ${entry.summary}`);
    if (entry.skill) lines.push(`  official skill: ${entry.skill} (load it if installed; it supersedes this entry)`);
    if (entry.check) lines.push(`  check: ${entry.check}`);
    lines.push(`  docs: ${entry.docs}`, '');
  }
  print(lines.slice(0, -1));
}

function showIndex(tools: Tool[], since: string, subject: string, json: boolean): void {
  const report = tools.map((tool) => {
    const installed = installedVersion(tool);
    const entries = tool.entries
      .filter((entry) => entryEnd(entry.date) >= since)
      .sort((a, b) => entryEnd(b.date).localeCompare(entryEnd(a.date)))
      .map((entry) => ({ entry, available: availability(entry, installed) }));
    return { tool, installed, entries };
  });

  if (json) {
    printJson({
      since,
      subject,
      tools: report.map(({ tool, installed, entries }) => ({
        tool: tool.tool,
        name: tool.name,
        installed,
        reviewed: tool.reviewed,
        changelogs: tool.changelogs,
        entries: entries.map(({ entry, available }) => ({
          id: entry.id,
          date: entry.date,
          version: entry.version,
          feature: entry.feature,
          available,
        })),
      })),
    });
    return;
  }

  const lines = [
    `Changes since ${since} (${subject}).`,
    'Before using one of these features, run --details <id> for its docs, checks and official skill.',
  ];
  for (const { tool, installed, entries } of report) {
    const meta = [installed && `installed ${installed}`, `reviewed ${tool.reviewed}`].filter(Boolean);
    lines.push('', `${tool.name} · ${meta.join(' · ')}`);
    if (entries.length === 0) lines.push('  Nothing new in this index.');
    const idWidth = Math.max(0, ...entries.map(({ entry }) => entry.id.length));
    const versionWidth = Math.max(0, ...entries.map(({ entry }) => entry.version?.length ?? 0));
    for (const { entry, available } of entries) {
      const columns = [entry.id.padEnd(idWidth), entry.date.padEnd(10)];
      if (versionWidth > 0) columns.push((entry.version ?? '').padEnd(versionWidth));
      columns.push(`${entry.feature}${upgradeNote(tool, entry, available)}`);
      lines.push(`  ${columns.join('  ')}`);
    }
    lines.push(`  After ${tool.reviewed}: ${tool.changelogs.join(' · ')}`);
  }
  print(lines);
}

const { values } = parseArgs({
  options: {
    tool: { type: 'string' },
    model: { type: 'string' },
    date: { type: 'string' },
    details: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const tools = readdirSync(DATA_DIR)
  .filter((file) => file.endsWith('.json') && file !== 'models.json')
  .sort()
  .map((file) => load(file, isTool));

const ids = tools.flatMap((tool) => tool.entries.map((entry) => entry.id));
const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
if (duplicate) fail(`Duplicate entry id in data: ${duplicate}`);

if (values.details) {
  showDetails(tools, list(values.details), values.json);
  process.exit(0);
}

const known = tools.map((t) => t.tool).join(', ');
if (!values.tool) fail(`Pass --tool with the tools you are about to use (${known}).`);
const wanted = list(values.tool);
const unknownTools = wanted.filter((t) => !tools.some((tool) => tool.tool === t));
if (unknownTools.length > 0) fail(`Unknown tool: ${unknownTools.join(', ')}. Known: ${known}.`);

if (!values.model && !values.date) fail('Pass --model <your model ID> or --date <your training cutoff, YYYY-MM[-DD]>.');

let cutoff = values.date;
let subject = `training cutoff ${cutoff}`;
if (values.model) {
  const { models } = load('models.json', isModels);
  const model = findModel(models, values.model);
  if (!model) {
    const knownModels = models.map((m) => `${m.id} (${m.cutoff})`).join(', ');
    fail(
      `Unknown model "${values.model}". Known: ${knownModels}.\n` +
        'Pass --date <your training cutoff, YYYY-MM> instead. ' +
        'If your cutoff is before every entry, all of them apply.',
    );
  }
  cutoff = model.cutoff;
  subject = `${model.id}, training cutoff ${model.cutoff}`;
}
if (!isDate(cutoff)) fail(`Invalid date "${cutoff}". Use YYYY-MM or YYYY-MM-DD.`);

showIndex(
  tools.filter((tool) => wanted.includes(tool.tool)),
  lookbackStart(cutoff),
  `${subject}, minus ${LOOKBACK_MONTHS} months of thin coverage`,
  values.json,
);
