import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createDeterministicZip(name, content) {
  const fileName = Buffer.from(name, "utf8");
  const bytes = Buffer.from(content);
  const checksum = crc32(bytes);
  const flags = 0x0800;
  const dosTime = 0;
  const dosDate = 0x0021;

  const local = Buffer.alloc(30 + fileName.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  local.writeUInt16LE(0, 28);
  fileName.copy(local, 30);

  const central = Buffer.alloc(46 + fileName.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  fileName.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + bytes.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([local, bytes, central, end]);
}

export async function buildAcquisitionProbeLambda({
  outputDirectory = ".data/acquisition-probe-build",
} = {}) {
  const output = path.resolve(outputDirectory);
  const buildResult = await build({
    entryPoints: ["diagnostics/acquisition-probe/src/lambda.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: ["node24"],
    conditions: ["node", "import"],
    minify: true,
    legalComments: "none",
    sourcemap: false,
    treeShaking: true,
  });
  const bundle = buildResult.outputFiles?.[0]?.contents;
  if (!bundle) throw new Error("The acquisition probe Lambda bundle was not produced.");
  const zip = createDeterministicZip("index.mjs", bundle);
  const manifest = {
    contract: "alice_acquisition_probe_lambda_zip_v1",
    runtime: "nodejs24.x",
    architecture: "arm64",
    handler: "index.handler",
    entry: "index.mjs",
    bundle_bytes: bundle.length,
    bundle_sha256: sha256(bundle),
    zip_bytes: zip.length,
    zip_sha256: sha256(zip),
    artifact_key: `artifacts/${sha256(zip)}.zip`,
  };
  await mkdir(output, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(path.join(output, "acquisition-probe-lambda.zip"), zip, { mode: 0o600 }),
    writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    }),
  ]);
  return { outputDirectory: output, zip, manifest };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  const outputIndex = process.argv.indexOf("--output");
  const outputDirectory = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && !outputDirectory) throw new Error("--output requires a directory.");
  const result = await buildAcquisitionProbeLambda({
    ...(outputDirectory ? { outputDirectory } : {}),
  });
  console.log(`Lambda ZIP: ${path.join(result.outputDirectory, "acquisition-probe-lambda.zip")}`);
  console.log(`ZIP SHA-256: ${result.manifest.zip_sha256}`);
  console.log(`Artifact key: ${result.manifest.artifact_key}`);
}
