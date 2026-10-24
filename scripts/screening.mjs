// Screening for the operator: is a deposit's source address sanctioned?
//
// Three sources, any hit means "not approved" (the deposit can still ragequit home):
//   1. screening/denylist.txt, our own list, one address per line,
//   2. the OFAC SDN list of Ethereum addresses, fetched from 0xB10C's daily export of
//      the Treasury's XML and cached in screening/ofac-eth.txt (refreshed every 12 hours;
//      the cache is used when the fetch fails),
//   3. the Chainalysis sanctions API when CHAINALYSIS_API_KEY is set (free key at
//      https://public.chainalysis.com).
//
// It fails closed: if a source that is turned on cannot answer, the address counts as
// unknown and is left pending for the next run instead of being approved.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OFAC_URL = "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt";
const OFAC_MAX_AGE = 12 * 3600_000;

const addresses = (text) =>
  new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => /^0x[0-9a-f]{40}$/.test(l)),
  );

async function ofacList(file) {
  const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < OFAC_MAX_AGE;
  if (!fresh) {
    try {
      const r = await fetch(OFAC_URL, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = addresses(await r.text());
      // A short list means a broken download, not a shorter sanctions list.
      if (list.size < 50) throw new Error(`only ${list.size} addresses`);
      writeFileSync(file, `# OFAC SDN Ethereum addresses, from ${OFAC_URL}\n# Fetched ${new Date().toISOString()}\n${[...list].join("\n")}\n`);
      return { list, note: `OFAC list refreshed (${list.size})` };
    } catch (e) {
      if (!existsSync(file)) return { list: null, note: `OFAC list unavailable: ${e.message}` };
      return { list: addresses(readFileSync(file, "utf8")), note: `OFAC fetch failed (${e.message}), using the cached list` };
    }
  }
  return { list: addresses(readFileSync(file, "utf8")), note: null };
}

/**
 * Returns check(address) -> "clean" | "flagged" | "unknown", plus notes on the sources.
 * Options: dir (defaults to screening/), chainalysisKey (defaults to CHAINALYSIS_API_KEY).
 */
export async function loadScreening({ dir = join(ROOT, "screening"), chainalysisKey = process.env.CHAINALYSIS_API_KEY } = {}) {
  const denyFile = process.env.ZHIELD_DENYLIST ?? join(dir, "denylist.txt");
  const deny = existsSync(denyFile) ? addresses(readFileSync(denyFile, "utf8")) : new Set();
  const ofac = await ofacList(join(dir, "ofac-eth.txt"));
  const notes = [ofac.note, chainalysisKey ? null : "No CHAINALYSIS_API_KEY: screening with the denylist and the OFAC list only"].filter(Boolean);

  async function check(address) {
    const a = address.toLowerCase();
    if (deny.has(a)) return { verdict: "flagged", source: "denylist" };
    if (!ofac.list) return { verdict: "unknown", source: "OFAC list unavailable" };
    if (ofac.list.has(a)) return { verdict: "flagged", source: "OFAC SDN" };
    if (!chainalysisKey) return { verdict: "clean" };
    try {
      const r = await fetch(`https://public.chainalysis.com/api/v1/address/${a}`, {
        headers: { "X-API-Key": chainalysisKey, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j.identifications)) throw new Error("unexpected answer");
      return j.identifications.length ? { verdict: "flagged", source: "Chainalysis" } : { verdict: "clean" };
    } catch (e) {
      return { verdict: "unknown", source: `Chainalysis: ${e.message}` };
    }
  }

  return { check, notes, sizes: { denylist: deny.size, ofac: ofac.list?.size ?? 0 } };
}
