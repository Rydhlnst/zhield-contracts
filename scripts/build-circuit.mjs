// Builds everything the contracts and the app need from circuits/withdraw.circom:
//   build/withdraw_js/withdraw.wasm   witness generator (browser + tests)
//   build/withdraw.zkey               Groth16 proving key
//   build/verification_key.json       verification key
//   src/Groth16Verifier.sol           on-chain verifier
//   build/PoseidonT3.hex / T2.hex     Poseidon hashers (2 and 1 inputs) as creation bytecode
//
// Phase 1 uses the Ethereum Foundation PSE Perpetual Powers of Tau (80 contributions,
// 2^15, enough for the ~22k constraints) plus one random
// contribution made here. That is fine for tests and a guarded launch; the
// public setup ceremony on the roadmap replaces this zkey before caps lift.
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { poseidonContract } from "circomlibjs";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const build = join(root, "build");
mkdirSync(build, { recursive: true });

const circom = process.env.CIRCOM ?? join(homedir(), ".zhield-tools", process.platform === "win32" ? "circom.exe" : "circom");
const snarkjs = (...args) => execFileSync(process.execPath, [join(root, "node_modules/snarkjs/build/cli.cjs"), ...args], { stdio: "inherit", cwd: root });

console.log("1/6 compile circuit");
execFileSync(circom, ["circuits/withdraw.circom", "--r1cs", "--wasm", "--sym", "-o", "build"], { stdio: "inherit", cwd: root });

const ptau = join(build, "pot15.ptau");
if (!existsSync(ptau)) {
  console.log("2/6 download Powers of Tau (PSE ppot, 2^15)");
  const res = await fetch("https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_15.ptau");
  if (!res.ok) throw new Error(`ptau download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(ptau));
} else console.log("2/6 Powers of Tau already here");

console.log("3/6 groth16 setup");
snarkjs("groth16", "setup", "build/withdraw.r1cs", "build/pot15.ptau", "build/withdraw_0000.zkey");

console.log("4/6 contribute");
snarkjs("zkey", "contribute", "build/withdraw_0000.zkey", "build/withdraw.zkey", "--name=zhield-phase1", `-e=${randomBytes(32).toString("hex")}`);
snarkjs("zkey", "export", "verificationkey", "build/withdraw.zkey", "build/verification_key.json");

console.log("5/6 export Solidity verifier");
snarkjs("zkey", "export", "solidityverifier", "build/withdraw.zkey", "src/Groth16Verifier.sol");
// snarkjs pins an old pragma range; keep the file but match the project compiler.
const verifier = readFileSync(join(root, "src/Groth16Verifier.sol"), "utf8").replace(/pragma solidity [^;]+;/, "pragma solidity ^0.8.24;");
writeFileSync(join(root, "src/Groth16Verifier.sol"), verifier);

console.log("6/6 Poseidon bytecode");
writeFileSync(join(build, "PoseidonT3.hex"), poseidonContract.createCode(2));
writeFileSync(join(build, "PoseidonT2.hex"), poseidonContract.createCode(1));

console.log("done");
