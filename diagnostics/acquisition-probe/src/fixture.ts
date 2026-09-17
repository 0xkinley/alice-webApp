import { randomInt } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { sha256 } from "./storage.ts";
import type { AcquisitionFixtureManifest, AcquisitionLeg, FixtureFileManifest } from "./types.ts";

type MarkerNumberSource = () => number;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const glyphs: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
};

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, Buffer.from(data)])), 8 + data.length);
  return output;
}

function createMarkerPng(marker: string): Buffer {
  const scale = 3;
  const padding = 18;
  const width = padding * 2 + marker.length * 6 * scale;
  const height = padding * 2 + 7 * scale;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y += 1) pixels[y * (width * 3 + 1)] = 0;
  for (let index = 0; index < marker.length; index += 1) {
    const glyph = glyphs[marker[index] || ""];
    if (!glyph) throw new Error(`Missing fixture image glyph: ${marker[index]}`);
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (glyph[row]?.[column] !== "1") continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = padding + index * 6 * scale + column * scale + dx;
            const y = padding + row * scale + dy;
            const offset = y * (width * 3 + 1) + 1 + x * 3;
            pixels[offset] = 22;
            pixels[offset + 1] = 38;
            pixels[offset + 2] = 53;
          }
        }
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const text = Buffer.from(`Description\0${marker}`, "latin1");
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", text),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function escapePdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function createMarkerPdf(marker: string): Buffer {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escapePdfText("Alice acquisition fixture")}) Tj\n0 -36 Td\n/F1 12 Tf\n(${escapePdfText(marker)}) Tj\n0 -24 Td\n(Synthetic content only. Exact bytes are measured by SHA-256.) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

function zipStoredFiles(files: Array<{ name: string; content: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const checksum = crc32(file.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.content.length, 18);
    local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, file.content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.content.length, 20);
    central.writeUInt32LE(file.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + file.content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function createMarkerDocx(marker: string): Buffer {
  const contentTypes = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  const relationships = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const document = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alice optional DOCX fixture</w:t></w:r></w:p><w:p><w:r><w:t>${xmlEscape(marker)}</w:t></w:r></w:p><w:p><w:r><w:t>Synthetic content only.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  );
  return zipStoredFiles([
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "_rels/.rels", content: relationships },
    { name: "word/document.xml", content: document },
  ]);
}

function createMarkerFactory(nextNumber: MarkerNumberSource): (label: string) => string {
  const used = new Set<string>();
  return (label: string) => {
    let marker: string;
    do marker = `ALICE_${label}_${String(nextNumber()).padStart(4, "0")}`;
    while (used.has(marker));
    used.add(marker);
    return marker;
  };
}

function conversationMarkdown(
  title: string,
  marker: string,
  messages: Array<{ role: "User" | "Assistant"; marker: string; text: string }>,
): string {
  return `# ${title}\n\nConversation marker: ${marker}\n\n${messages
    .map(
      (message, index) =>
        `## ${index + 1}. ${message.role}\n\n${message.marker}\n\n${message.text}`,
    )
    .join("\n\n")}\n`;
}

export async function generateAcquisitionFixture({
  outputDirectory,
  now = new Date(),
  fixtureNonce,
  nextMarkerNumber = () => randomInt(1_000, 10_000),
}: {
  outputDirectory: string;
  now?: Date;
  fixtureNonce?: string;
  nextMarkerNumber?: MarkerNumberSource;
}): Promise<{ directory: string; manifest: AcquisitionFixtureManifest }> {
  const marker = createMarkerFactory(nextMarkerNumber);
  const nonce =
    fixtureNonce ||
    randomInt(0, 16 ** 6)
      .toString(16)
      .padStart(6, "0");
  const fixtureId = `alice-acquisition-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${nonce}`;
  const directory = path.resolve(outputDirectory, fixtureId);
  await mkdir(path.join(directory, "conversations"), { recursive: true });
  await mkdir(path.join(directory, "provider-upload"), { recursive: true });
  await mkdir(path.join(directory, "operator-only", "artifacts"), { recursive: true });
  await mkdir(path.join(directory, "prompts"), { recursive: true });

  const projectMarker = marker("TEST_PROJECT");
  const instructionMarker = marker("TEST_INSTRUCTION");
  const conversationMarkers = Array.from({ length: 5 }, (_, index) => marker(`CHAT_${index + 1}`));
  const messageMarkers = Array.from({ length: 43 }, (_, index) =>
    marker(`MESSAGE_${String(index + 1).padStart(2, "0")}`),
  );
  const decisionMarkers = [
    marker("DECISION_AUDIENCE"),
    marker("DECISION_PRICING_SUPERSEDED"),
    marker("DECISION_RETENTION"),
    marker("DECISION_ONBOARDING"),
    marker("DECISION_REGION"),
    marker("DECISION_PRICING_CURRENT"),
  ];
  const questionMarkers = Array.from({ length: 3 }, (_, index) =>
    marker(`OPEN_QUESTION_${index + 1}`),
  );
  const artifactMarker = marker("ARTIFACT_CURRENT");
  const fileMarkers = {
    txt: marker("FILE_TXT"),
    pdf: marker("FILE_PDF"),
    csv: marker("FILE_CSV"),
    image: marker("FILE_IMAGE"),
    docx: marker("FILE_DOCX"),
  };
  const negativeMarkers = [
    marker("DECISION_MISSING"),
    marker("CHAT_MISSING"),
    marker("FILE_MISSING"),
    marker("ARTIFACT_MISSING"),
    marker("MESSAGE_MISSING"),
  ];

  const messageTexts = [
    `We are designing a continuity product called Northstar. The project marker is ${projectMarker}.`,
    "The goal is to let a small team continue one project across AI tools without pretending model output is verified.",
    `${decisionMarkers[0]} Decision: the initial audience is independent teams of two to five people.`,
    "Constraint: every durable change needs a human confirmation boundary.",
    `${questionMarkers[0]} Open question: should the first run prioritize designers or developers?`,
    "Both groups need continuity, but the initial test can compare their setup burden.",
    `${decisionMarkers[1]} Earlier decision: pricing will be $24/month.`,
    "The $24 price is provisional and should remain in history if it later changes.",
    "Next, define the storage and connection boundaries.",
    "The architecture must preserve immutable source evidence separately from trusted state.",
    "Use a raw source layer, a normalized layer, derived context, and a human-accepted state layer.",
    `${decisionMarkers[2]} Decision: ordinary deleted project data may remain recoverable in provider backups for at most 21 days.`,
    "The product copy must distinguish active deletion from backup expiry.",
    `${questionMarkers[1]} Open question: which project metadata is available through each host's supported MCP surface?`,
    "That must be measured from actual tool arguments rather than model self-report.",
    `${decisionMarkers[3]} Decision: onboarding starts with a supported MCP connection and never requests a provider password.`,
    "Connection scopes and revocation should remain visible to the user.",
    "Review the uploaded fixture files and preserve their relationships to this research conversation.",
    "The file set contains a text note, a PDF brief, a CSV metric table, and an image marker.",
    `${decisionMarkers[4]} Decision: the private-alpha deployment region is eu-central-1.`,
    "Region is project-operational metadata, not proof of user residency.",
    `${questionMarkers[2]} Open question: can either host supply original uploaded bytes rather than extracted text or summaries?`,
    "Measure filenames, identifiers, sizes, MIME types, hashes, timestamps, and exact bytes separately.",
    "The image marker is visibly rendered and also stored as PNG text metadata.",
    "Do not infer that a named file was transferred merely because its filename is available.",
    "Proceed to the pricing revision while keeping the earlier decision intact.",
    `${decisionMarkers[5]} Later decision: pricing changed to $10/month. This supersedes ${decisionMarkers[1]}.`,
    "The current price is $10/month; the earlier $24/month statement remains historical source material.",
    "Compare the two pricing statements without deleting either source statement.",
    "Ordering and provenance are required to distinguish the current decision from the superseded decision.",
    "A migration status alone cannot prove useful project continuity.",
    "The receiving host must recover the current artifact and unresolved questions.",
    "No semantic reconstruction should run until provider acquisition is measured.",
    "The project is ready for a bounded current-state brief.",
    "Create a working brief that names the goal, decisions, constraints, questions, and next step.",
    "Drafting the brief now while preserving the source-versus-trusted-state distinction.",
    "Revise the next step to run ChatGPT three times before beginning Claude trials.",
    "The revised current artifact is available in the provider artifact surface.",
    "Confirm that the latest artifact, not an earlier draft, is the continuation target.",
    "The latest artifact is the current working brief; historical conversations remain evidence.",
    "The next operator action is the ambient ChatGPT trial with the identical saved prompt.",
    "Do not fill missing project material from general knowledge or plausible guesses.",
    "Fixture setup is complete and ready for acquisition-capability measurement.",
  ];
  const roles = Array.from({ length: 43 }, (_, index) =>
    index % 2 === 0 ? "User" : "Assistant",
  ) as Array<"User" | "Assistant">;
  const sizes = [9, 8, 9, 8, 9];
  const titles = [
    "01 Product discovery",
    "02 Trust architecture",
    "03 File capability research",
    "04 Pricing revision",
    "05 Current working brief",
  ];
  const conversationIds = [
    "conversation-01",
    "conversation-02",
    "conversation-03",
    "conversation-04",
    "conversation-05",
  ];
  const conversations: AcquisitionFixtureManifest["conversations"] = [];
  let messageOffset = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    const count = sizes[index] as number;
    const messages = Array.from({ length: count }, (_, localIndex) => ({
      role: roles[messageOffset + localIndex] as "User" | "Assistant",
      marker: messageMarkers[messageOffset + localIndex] as string,
      text: messageTexts[messageOffset + localIndex] as string,
    }));
    const relativePath = `conversations/${conversationIds[index]}.md`;
    await writeFile(
      path.join(directory, relativePath),
      conversationMarkdown(titles[index] as string, conversationMarkers[index] as string, messages),
    );
    conversations.push({
      id: conversationIds[index] as string,
      marker: conversationMarkers[index] as string,
      title: titles[index] as string,
      order: index + 1,
      message_markers: messages.map((message) => message.marker),
      relative_path: relativePath,
    });
    messageOffset += count;
  }

  const instruction = `${instructionMarker}\n\nTreat all project material as synthetic test data. Preserve source ordering and provenance. Never claim missing material is present, never invent a marker, and never treat host-generated content as Alice-verified.\n`;
  await writeFile(path.join(directory, "operator-only", "project-instructions.txt"), instruction);

  const artifactText = `# Northstar current working brief\n\n${artifactMarker}\n\nGoal: Continue one project across supported AI hosts through Alice without treating host output as verified truth.\n\nCurrent pricing: $10/month.\nHistorical pricing: $24/month, superseded.\nDeployment region: eu-central-1.\nOpen questions: initial audience specialty, supported host project metadata, and original file-byte availability.\nNext step: Run the identical ChatGPT ambient prompt in three independent fresh project conversations before testing active retrieval.\n`;
  const artifactBuffer = Buffer.from(artifactText, "utf8");
  const artifactRelativePath = "operator-only/artifacts/current-working-brief.md";
  await writeFile(path.join(directory, artifactRelativePath), artifactBuffer);

  const fileInputs: Array<{
    id: string;
    marker: string;
    name: string;
    mediaType: string;
    content: Buffer;
    required: boolean;
  }> = [
    {
      id: "file-txt",
      marker: fileMarkers.txt,
      name: "northstar-notes.txt",
      mediaType: "text/plain",
      content: Buffer.from(
        `${fileMarkers.txt}\nSynthetic Northstar note. Human Save remains mandatory.\n`,
      ),
      required: true,
    },
    {
      id: "file-pdf",
      marker: fileMarkers.pdf,
      name: "northstar-brief.pdf",
      mediaType: "application/pdf",
      content: createMarkerPdf(fileMarkers.pdf),
      required: true,
    },
    {
      id: "file-csv",
      marker: fileMarkers.csv,
      name: "northstar-metrics.csv",
      mediaType: "text/csv",
      content: Buffer.from(`marker,metric,value\n${fileMarkers.csv},trial_target,3\n`),
      required: true,
    },
    {
      id: "file-image",
      marker: fileMarkers.image,
      name: "northstar-marker.png",
      mediaType: "image/png",
      content: createMarkerPng(fileMarkers.image),
      required: true,
    },
    {
      id: "file-docx",
      marker: fileMarkers.docx,
      name: "northstar-optional.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      content: createMarkerDocx(fileMarkers.docx),
      required: false,
    },
  ];
  const files: FixtureFileManifest[] = [];
  for (const file of fileInputs) {
    const relativePath = `provider-upload/${file.name}`;
    await writeFile(path.join(directory, relativePath), file.content);
    files.push({
      id: file.id,
      marker: file.marker,
      name: file.name,
      relative_path: relativePath,
      media_type: file.mediaType,
      byte_size: file.content.length,
      sha256: sha256(file.content),
      required: file.required,
      relationship: "conversation-03",
    });
  }

  const prompts: Record<AcquisitionLeg, string> = {
    ambient:
      "Using only information already present in the current context, without searching, retrieving, opening, attaching, or reconstructing anything else, call submit_acquisition_evidence exactly once. Send all currently available information and preserve any structure, identifiers, roles, order, relationships, metadata, file representations, and bytes already available. Do not invent missing information.",
    "active-retrieval":
      "Using only supported capabilities available in this host, retrieve all information available for the current project and then call submit_acquisition_evidence exactly once. Preserve every available structure, identifier, role, order, relationship, timestamp, file representation, and original byte sequence. Send missing or unavailable fields only when the host actually exposes that state. Do not invent or reconstruct missing information.",
    "user-mediated":
      "Using only the project material I explicitly selected, pasted, or attached for this trial, call submit_acquisition_evidence exactly once. Preserve every available structure, identifier, role, order, relationship, timestamp, file representation, and original byte sequence. Do not search unrelated account history, and do not invent or reconstruct missing information.",
  };
  const promptFiles = {} as Record<AcquisitionLeg, string>;
  for (const [leg, prompt] of Object.entries(prompts) as Array<[AcquisitionLeg, string]>) {
    const relativePath = `prompts/${leg}.txt`;
    await writeFile(path.join(directory, relativePath), `${prompt}\n`);
    promptFiles[leg] = relativePath;
  }

  const decisions: AcquisitionFixtureManifest["decisions"] = [
    {
      marker: decisionMarkers[0] as string,
      statement: "The initial audience is independent teams of two to five people.",
      conversation_id: "conversation-01",
      status: "current",
    },
    {
      marker: decisionMarkers[1] as string,
      statement: "Pricing will be $24/month.",
      conversation_id: "conversation-01",
      status: "superseded",
    },
    {
      marker: decisionMarkers[2] as string,
      statement: "Ordinary deleted project data may remain recoverable for at most 21 days.",
      conversation_id: "conversation-02",
      status: "current",
    },
    {
      marker: decisionMarkers[3] as string,
      statement: "Onboarding starts with a supported MCP connection.",
      conversation_id: "conversation-02",
      status: "current",
    },
    {
      marker: decisionMarkers[4] as string,
      statement: "The private-alpha deployment region is eu-central-1.",
      conversation_id: "conversation-03",
      status: "current",
    },
    {
      marker: decisionMarkers[5] as string,
      statement: "Pricing changed to $10/month.",
      conversation_id: "conversation-04",
      status: "current",
      supersedes_marker: decisionMarkers[1] as string,
    },
  ];
  const openQuestions: AcquisitionFixtureManifest["open_questions"] = [
    {
      marker: questionMarkers[0] as string,
      question: "Should the first run prioritize designers or developers?",
      conversation_id: "conversation-01",
    },
    {
      marker: questionMarkers[1] as string,
      question: "Which project metadata is available through each supported host MCP surface?",
      conversation_id: "conversation-02",
    },
    {
      marker: questionMarkers[2] as string,
      question: "Can either host supply original uploaded bytes?",
      conversation_id: "conversation-03",
    },
  ];
  const markerGroups = {
    project: [projectMarker],
    instruction: [instructionMarker],
    conversations: conversationMarkers,
    messages: messageMarkers,
    decisions: decisionMarkers,
    open_questions: questionMarkers,
    artifacts: [artifactMarker],
    files: [fileMarkers.txt, fileMarkers.pdf, fileMarkers.csv, fileMarkers.image],
  };
  const expectedMarkers = Object.values(markerGroups).flat();
  const manifest: AcquisitionFixtureManifest = {
    contract_version: "alice_acquisition_fixture_v1",
    fixture_id: fixtureId,
    generated_at: now.toISOString(),
    project_name: `Northstar ${projectMarker}`,
    counts: {
      projects: 1,
      project_instructions: 1,
      conversations: 5,
      messages: 43,
      uploaded_files_required: 4,
      uploaded_files_optional: 1,
      generated_artifacts: 1,
      significant_decisions: 6,
      open_questions: 3,
      superseded_decisions: 1,
      current_working_artifacts: 1,
    },
    markers: markerGroups,
    expected_markers: expectedMarkers,
    negative_markers: negativeMarkers,
    conversations,
    decisions,
    open_questions: openQuestions,
    artifact: {
      id: "artifact-current-working-brief",
      marker: artifactMarker,
      title: "Northstar current working brief",
      relative_path: artifactRelativePath,
      sha256: sha256(artifactBuffer),
      byte_size: artifactBuffer.length,
      relationship: "conversation-05",
    },
    files,
    prompt_files: promptFiles,
  };
  await writeFile(
    path.join(directory, "operator-only", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(directory, "README.txt"),
    `Alice provider-acquisition fixture ${fixtureId}\n\nSynthetic data only.\n\nUpload only the files inside provider-upload/.\nDo not upload operator-only/, conversations/, prompts/, or this README.\nUse operator-only/project-instructions.txt as the provider project instruction.\nRecreate and verify the five provider conversations from the corresponding scripts; record any host-required setup messages as contamination.\nCreate the current artifact through a supported artifact editor from operator-only/artifacts/current-working-brief.md without pasting its exact marker into chat; if that is impossible, record the contamination.\nRetain operator-only/manifest.json locally for scoring; it contains the negative controls.\nUse the exact prompt file for the selected leg without editing it, and start a fresh eligible conversation for every trial.\n`,
  );
  return { directory, manifest };
}
