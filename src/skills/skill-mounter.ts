/**
 * skill-mounter.ts — Skill Lockfile Verifier (Wave 3, SPEC Section 2.3).
 *
 * Reads `.skill-lock.json` (version 3, vercel-labs/skills format with
 * `skillFolderHash`) and `grimoire.lock` (verifying the RFC 8785 JCS
 * `declaration_hash`), computes deterministic SHA-256 tree hashes of local
 * skill directories, and refuses to mount any skill whose directory hash
 * mismatches the lockfile (fail-closed).
 *
 * Hash construction (deterministic):
 *   1. Recursively collect every regular file under the skill directory.
 *   2. Sort relative POSIX paths lexicographically (byte order).
 *   3. Feed `relPath + "\0" + fileBytes + "\0"` for each file, in order,
 *      into a single SHA-256 digest; the hex digest is the tree hash.
 *   4. Symlinks, sockets, FIFOs, and other non-regular files are rejected
 *      fail-closed. Missing directories and missing `SKILL.md` are errors.
 *
 * JCS canonicalization (RFC 8785 subset sufficient for this lockfile):
 *   object keys sorted lexicographically, no insignificant whitespace,
 *   standard JSON string escaping via `JSON.stringify`, numbers serialized
 *   without trailing octet ambiguity (integers only in our lockfiles).
 */

import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

export const SKILL_LOCK_VERSION = 3 as const;
export const SKILL_ENTRY_FILE = "SKILL.md" as const;

export interface SkillLockEntry {
  name: string;
  skillDir: string;
  skillFolderHash: string;
  version?: string;
  source?: string;
}

export interface SkillLockFile {
  version: number;
  skills: SkillLockEntry[];
}

export interface GrimoireLockFile {
  version?: number;
  tool?: string;
  declarations: Record<string, unknown>;
  declaration_hash: string;
}

export interface MountedSkill {
  name: string;
  skillDir: string;
  skillFolderHash: string;
  skillMd: string;
}

export interface SkillVerifyResult {
  name: string;
  skillDir: string;
  expectedHash: string;
  actualHash: string;
}

export class SkillLockError extends Error {
  readonly code: string = "SKILL_LOCK_ERROR";
}

export class SkillLockVersionError extends SkillLockError {
  readonly code = "SKILL_LOCK_VERSION_MISMATCH";
}

export class SkillHashMismatchError extends SkillLockError {
  readonly code = "SKILL_HASH_MISMATCH";
  readonly skillName: string;
  readonly expectedHash: string;
  readonly actualHash: string;
  constructor(skillName: string, expectedHash: string, actualHash: string) {
    super(
      `Skill "${skillName}" directory hash mismatch: expected ${expectedHash}, computed ${actualHash}. Refusing to mount (fail-closed).`,
    );
    this.skillName = skillName;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export class UnknownSkillError extends SkillLockError {
  readonly code = "UNKNOWN_SKILL";
}

export class GrimoireHashMismatchError extends SkillLockError {
  readonly code = "GRIMOIRE_HASH_MISMATCH";
  readonly expectedHash: string;
  readonly actualHash: string;
  constructor(expectedHash: string, actualHash: string) {
    super(
      `grimoire.lock declaration_hash mismatch: expected ${expectedHash}, computed ${actualHash}. Refusing to mount (fail-closed).`,
    );
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Recursively canonicalize a JSON value per RFC 8785 JCS: object keys are
 * sorted lexicographically at every level; arrays preserve order; primitives
 * pass through. Serialization uses `JSON.stringify` (no whitespace), which
 * matches JCS for the string/number/boolean/null shapes used in lockfiles.
 */
export function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalizeJsonValue(value[key]);
    }
    return out;
  }
  return value;
}

/** Canonical JSON string (RFC 8785 JCS) for hashing. */
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Constant-time hex digest comparison; false on shape mismatch. */
export function equalHashes(a: string, b: string): boolean {
  if (!isHex64(a) || !isHex64(b)) {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function toPosixPath(p: string): string {
  return p.split(sep).join("/");
}

function collectSkillFiles(skillDir: string): string[] {
  const relPaths: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      throw new SkillLockError(
        `Cannot read skill directory "${skillDir}": directory unreadable or missing. Failing closed.`,
      );
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = toPosixPath(relative(skillDir, full));
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        throw new SkillLockError(
          `Cannot stat "${rel}" inside skill directory "${skillDir}". Failing closed.`,
        );
      }
      if (st.isSymbolicLink()) {
        throw new SkillLockError(
          `Skill directory "${skillDir}" contains symlink "${rel}": symlinks are rejected fail-closed.`,
        );
      }
      if (st.isDirectory()) {
        visit(full);
      } else if (st.isFile()) {
        relPaths.push(rel);
      } else {
        throw new SkillLockError(
          `Skill directory "${skillDir}" contains non-regular file "${rel}": rejected fail-closed.`,
        );
      }
    }
  };
  visit(skillDir);
  relPaths.sort();
  return relPaths;
}

/**
 * Computes the deterministic SHA-256 tree hash of a skill directory.
 * Requires the directory to exist and to contain a top-level `SKILL.md`.
 */
export function computeTreeHash(skillDir: string): string {
  if (typeof skillDir !== "string" || skillDir.length === 0) {
    throw new SkillLockError("skillDir must be a non-empty string. Failing closed.");
  }
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(skillDir);
  } catch {
    throw new SkillLockError(
      `Skill directory not found: "${skillDir}". Failing closed.`,
    );
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new SkillLockError(
      `Skill path "${skillDir}" is not a directory (or is a symlink). Failing closed.`,
    );
  }
  if (!existsSync(join(skillDir, SKILL_ENTRY_FILE))) {
    throw new SkillLockError(
      `Skill directory "${skillDir}" is missing required entry file "${SKILL_ENTRY_FILE}". Failing closed.`,
    );
  }
  const files = collectSkillFiles(skillDir);
  if (files.length === 0) {
    throw new SkillLockError(
      `Skill directory "${skillDir}" contains no files. Failing closed.`,
    );
  }
  const hash = createHash("sha256");
  for (const rel of files) {
    const bytes = readFileSync(join(skillDir, ...rel.split("/")));
    hash.update(rel, "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function assertValidLockEntry(entry: unknown, index: number): asserts entry is SkillLockEntry {
  if (!isRecord(entry)) {
    throw new SkillLockError(`.skill-lock.json skills[${index}] must be an object. Failing closed.`);
  }
  if (typeof entry["name"] !== "string" || (entry["name"] as string).length === 0) {
    throw new SkillLockError(`.skill-lock.json skills[${index}].name must be a non-empty string. Failing closed.`);
  }
  if (typeof entry["skillDir"] !== "string" || (entry["skillDir"] as string).length === 0) {
    throw new SkillLockError(`.skill-lock.json skills[${index}].skillDir must be a non-empty string. Failing closed.`);
  }
  if (typeof entry["skillFolderHash"] !== "string" || !isHex64(entry["skillFolderHash"] as string)) {
    throw new SkillLockError(
      `.skill-lock.json skills[${index}].skillFolderHash must be a 64-char lowercase hex SHA-256 digest. Failing closed.`,
    );
  }
  if (entry["version"] !== undefined && typeof entry["version"] !== "string") {
    throw new SkillLockError(`.skill-lock.json skills[${index}].version must be a string when present. Failing closed.`);
  }
  if (entry["source"] !== undefined && typeof entry["source"] !== "string") {
    throw new SkillLockError(`.skill-lock.json skills[${index}].source must be a string when present. Failing closed.`);
  }
}

/** Loads and validates `.skill-lock.json` (version must be exactly 3). */
export function loadSkillLock(lockPath: string): SkillLockFile {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    throw new SkillLockError(`Skill lockfile not found: "${lockPath}". Failing closed.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillLockError(`Skill lockfile "${lockPath}" is not valid JSON. Failing closed.`);
  }
  if (!isRecord(parsed)) {
    throw new SkillLockError(`Skill lockfile "${lockPath}" must be a JSON object. Failing closed.`);
  }
  if (parsed["version"] !== SKILL_LOCK_VERSION) {
    throw new SkillLockVersionError(
      `Skill lockfile "${lockPath}" version ${String(parsed["version"])} is unsupported: expected version ${SKILL_LOCK_VERSION}. Failing closed.`,
    );
  }
  if (!Array.isArray(parsed["skills"]) || parsed["skills"].length === 0) {
    throw new SkillLockError(`Skill lockfile "${lockPath}" must declare a non-empty "skills" array. Failing closed.`);
  }
  const seen = new Set<string>();
  const skills: SkillLockEntry[] = [];
  (parsed["skills"] as unknown[]).forEach((entry, index) => {
    assertValidLockEntry(entry, index);
    if (seen.has(entry.name)) {
      throw new SkillLockError(`Skill lockfile "${lockPath}" declares duplicate skill name "${entry.name}". Failing closed.`);
    }
    seen.add(entry.name);
    skills.push({
      name: entry.name,
      skillDir: entry.skillDir,
      skillFolderHash: entry.skillFolderHash,
      ...(typeof entry.version === "string" ? { version: entry.version } : {}),
      ...(typeof entry.source === "string" ? { source: entry.source } : {}),
    });
  });
  return { version: SKILL_LOCK_VERSION, skills };
}

/** Resolves a lockfile `skillDir` (workspace-relative) to an absolute path. */
export function resolveSkillDir(workspaceRoot: string, skillDir: string): string {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new SkillLockError("workspaceRoot must be a non-empty string. Failing closed.");
  }
  if (typeof skillDir !== "string" || skillDir.length === 0) {
    throw new SkillLockError("skillDir must be a non-empty string. Failing closed.");
  }
  if (skillDir.startsWith("/") || skillDir.includes("..")) {
    throw new SkillLockError(`skillDir "${skillDir}" must be a workspace-relative path without ".." or leading "/". Failing closed.`);
  }
  return join(workspaceRoot, ...skillDir.split("/"));
}

/** Default lockfile locations relative to the workspace root. */
export function defaultSkillLockPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".skill-lock.json");
}

export function defaultGrimoireLockPath(workspaceRoot: string): string {
  return join(workspaceRoot, "grimoire.lock");
}

export interface VerifyOptions {
  workspaceRoot: string;
  lockPath?: string;
}

/**
 * Verifies every skill in the lockfile: recomputes each directory tree hash
 * and throws `SkillHashMismatchError` on the first mismatch (fail-closed).
 */
export function verifySkillLock(options: VerifyOptions): SkillVerifyResult[] {
  const lockPath = options.lockPath ?? defaultSkillLockPath(options.workspaceRoot);
  const lock = loadSkillLock(lockPath);
  const results: SkillVerifyResult[] = [];
  for (const entry of lock.skills) {
    const absolute = resolveSkillDir(options.workspaceRoot, entry.skillDir);
    const actual = computeTreeHash(absolute);
    if (!equalHashes(actual, entry.skillFolderHash)) {
      throw new SkillHashMismatchError(entry.name, entry.skillFolderHash, actual);
    }
    results.push({
      name: entry.name,
      skillDir: entry.skillDir,
      expectedHash: entry.skillFolderHash,
      actualHash: actual,
    });
  }
  return results;
}

export interface GrimoireVerifyOptions {
  workspaceRoot: string;
  grimoirePath?: string;
}

/** Loads `grimoire.lock` and verifies its RFC 8785 JCS `declaration_hash`. */
export function verifyGrimoireLock(options: GrimoireVerifyOptions): { declarations: Record<string, unknown>; declarationHash: string } {
  const lockPath = options.grimoirePath ?? defaultGrimoireLockPath(options.workspaceRoot);
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    throw new SkillLockError(`grimoire.lock not found: "${lockPath}". Failing closed.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillLockError(`grimoire.lock "${lockPath}" is not valid JSON. Failing closed.`);
  }
  if (!isRecord(parsed)) {
    throw new SkillLockError(`grimoire.lock "${lockPath}" must be a JSON object. Failing closed.`);
  }
  if (!isRecord(parsed["declarations"])) {
    throw new SkillLockError(`grimoire.lock "${lockPath}" must contain a "declarations" object. Failing closed.`);
  }
  if (typeof parsed["declaration_hash"] !== "string" || !isHex64(parsed["declaration_hash"] as string)) {
    throw new SkillLockError(`grimoire.lock "${lockPath}" must contain a 64-char hex "declaration_hash". Failing closed.`);
  }
  const declarations = parsed["declarations"] as Record<string, unknown>;
  const computed = sha256Hex(canonicalizeJson(declarations));
  const expected = parsed["declaration_hash"] as string;
  if (!equalHashes(computed, expected)) {
    throw new GrimoireHashMismatchError(expected, computed);
  }
  return { declarations, declarationHash: expected };
}

export interface MountOptions {
  workspaceRoot: string;
  skillName: string;
  lockPath?: string;
  grimoirePath?: string;
  verifyGrimoire?: boolean;
}

/** Lists locked skill names without touching the filesystem. */
export function listLockedSkills(lockPath: string): string[] {
  return loadSkillLock(lockPath).skills.map((s) => s.name);
}

/**
 * Mounts one task-scoped skill: optionally verifies the grimoire
 * declaration hash, locates the skill entry, recomputes its tree hash,
 * refuses on mismatch (fail-closed), and returns the `SKILL.md` content.
 */
export function mountSkill(options: MountOptions): MountedSkill {
  if (typeof options.skillName !== "string" || options.skillName.length === 0) {
    throw new SkillLockError("skillName must be a non-empty string. Failing closed.");
  }
  if (options.verifyGrimoire === true) {
    verifyGrimoireLock({ workspaceRoot: options.workspaceRoot, grimoirePath: options.grimoirePath });
  }
  const lockPath = options.lockPath ?? defaultSkillLockPath(options.workspaceRoot);
  const lock = loadSkillLock(lockPath);
  const entry = lock.skills.find((s) => s.name === options.skillName);
  if (entry === undefined) {
    throw new UnknownSkillError(
      `Unknown skill "${options.skillName}". Locked skills: ${lock.skills.map((s) => s.name).join(", ")}. Failing closed.`,
    );
  }
  const absolute = resolveSkillDir(options.workspaceRoot, entry.skillDir);
  const actual = computeTreeHash(absolute);
  if (!equalHashes(actual, entry.skillFolderHash)) {
    throw new SkillHashMismatchError(entry.name, entry.skillFolderHash, actual);
  }
  const skillMd = readFileSync(join(absolute, SKILL_ENTRY_FILE), "utf8");
  if (skillMd.length === 0) {
    throw new SkillLockError(`Skill "${entry.name}" entry file "${SKILL_ENTRY_FILE}" is empty. Failing closed.`);
  }
  return {
    name: entry.name,
    skillDir: entry.skillDir,
    skillFolderHash: entry.skillFolderHash,
    skillMd,
  };
}
