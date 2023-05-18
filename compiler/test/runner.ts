import { marked } from "https://esm.sh/marked@4.0.18";
import { assertEquals } from "https://deno.land/std@0.154.0/testing/asserts.ts";

type CodeBlock = {
  index: number;
  description: string;
  code: string;
  expected: string;
};

const COMPILER_DIR = Deno.cwd() + "/";
const BIN = COMPILER_DIR + "../target/debug/compiler";
const SEEN_EXPECTATIONS = new Set();

const mode = Deno.args[0] || "all";
const runAll = mode === "all" && import.meta.main;

if (runAll || mode === "infer") {
  await runTestFile("infer-expr", async (block, snapshotFolder) => {
    const out = await callCompiler({ InferExpr: block.code });
    const exp = runExpectations(out, block);
    await writeExpectation(snapshotFolder, exp, block);
  });
}

if (runAll || mode === "infer-file") {
  await runTestFile("infer-file", async (block, snapshotFolder) => {
    const out = await callCompiler({ InferPackage: block.code });
    const exp = runExpectations(out, block);
    await writeExpectation(snapshotFolder, exp, block);
  });
}

if (runAll || mode === "emit") {
  await runTestFile("codegen-emit", async (block, snapshotFolder) => {
    await initProject("/tmp/borgo-emit", block);
    const output = await buildAndRunProject();
    const exp = appendGoSource(output);

    Deno.chdir(COMPILER_DIR);
    await writeExpectation(snapshotFolder, exp, block);

    return output;
  });
}

async function runTestFile(
  file: string,
  blockCb: (
    block: CodeBlock,
    snapshotFolder: string,
  ) => Promise<string | void>,
) {
  const content = Deno.readTextFileSync(`test/${file}.md`);
  const codeBlocks = markdownToCodeblocks(content);
  const folder = `test/snapshot/${file}/`;

  for (const block of codeBlocks) {
    console.log(block.description);
    console.log(block.expected);
    console.log(block.code);

    const output = await blockCb(block, folder);
    if (output) {
      console.log("\n---\n");
      console.log(output);
    }

    console.log("OK\n\n---\n");
  }
}

function runExpectations(out: string, block: CodeBlock) {
  const [ty, error] = out.split("\n---\n");
  let has_errors = error !== "No errors.";

  let ret = out;

  function errorContains(msg: string) {
    if (!has_errors) {
      exit(`
Was expecting error:
  ${msg}
But compiler did not fail.
`);
    }

    if (!inline(error).includes(msg)) {
      exit(`
Was expecting error to include:
  ${msg}
But compiler returned:
  ${error}
`);
    }

    // Only include error in output
    ret = error;
  }

  function infer(expected: string) {
    if (has_errors) {
      exit(`
Was not expecting compiler to fail:
  ${error}
`);
    }

    if (expected !== ty) {
      exit(`
Was expecting type:
  ${expected}
But compiler inferred:
  ${ty}
`);
    }
  }

  eval(block.expected);
  return ret;
}

async function writeExpectation(folder: string, out: string, block: CodeBlock) {
  const filename = slugify(block.description);

  const exp = folder + filename;
  if (SEEN_EXPECTATIONS.has(exp)) {
    exit(`Duplicated test ${exp}`);
  }

  SEEN_EXPECTATIONS.add(exp);

  const new_out = replaceUnboundVars(out);
  const content = `${block.description}

SOURCE:
${block.code}

OUTPUT:
${new_out}`;

  Deno.writeTextFileSync(
    `${folder}/${filename}.exp`,
    content,
  );
}

async function callCompiler(input: any): Promise<string> {
  const cmd = [BIN, JSON.stringify(input)];
  const { code, err, output } = await runShell(cmd);

  if (code === 0 && err) {
    console.log(err);
    exit("stopping because of debug output");
  }

  if (code > 1) {
    console.log(err);
    exit("Was not expecting compiler to fail");
  }

  return output;
}

async function runShell(
  cmd: any,
): Promise<{ code: number; output: string; err: string }> {
  const p = Deno.run({
    cmd,
    stdout: "piped",
    stderr: "piped",
  });

  const streams = (await Promise.all([p.stderrOutput(), p.output()])).map(
    decode,
  );

  const { code } = await p.status();
  const [err, output] = streams;
  return { code, output, err };
}

export function markdownToCodeblocks(content: string): Array<CodeBlock> {
  let codeBlocks: Array<CodeBlock> = [];
  let description: Array<string> = [];
  let only: CodeBlock | undefined;
  let currentIndex = 1;
  let pastIntro = false; // skip initial h1 and text description
  let expected = ""; // contents of > blockquote

  marked.parse(content, {
    walkTokens(token) {
      if (token.type === "hr") {
        pastIntro = true;
        return;
      }

      if (only || !pastIntro) return;

      if (token.type === "blockquote") {
        expected = token.text;
        return;
      }

      if (token.type === "paragraph" && !expected) {
        description.push(token.text);
        return;
      }

      if (token.type === "heading") {
        description.push(token.text);
        return;
      }

      if (token.type === "code") {
        const block = {
          index: currentIndex++,
          description: description.join("\n"),
          code: token.text,
          expected,
        };
        description = [];
        expected = "";

        if (token.lang === "rust-only") {
          only = block;
          return;
        }

        if (token.lang === "rust-skip") {
          // Skip this test
          return;
        }

        codeBlocks.push(block);
      }
    },
  });

  // console.log(codeBlocks)

  if (only) codeBlocks = [only];

  return codeBlocks;
}

function exit(msg: string) {
  if (msg) console.log(msg);
  Deno.exit(1);
}

function splitInFiles(input: string) {
  let files = input.split("file:");
  if (files.length == 1) {
    // No "file:" found
    return [{ filename: "app.brg", contents: input }];
  }

  return files.filter(Boolean).map((f) => {
    const i = f.indexOf("\n");
    const filename = f.substr(0, i).trim();
    const contents = f.substr(i);

    return { filename, contents };
  });
}

export async function initProject(folder: string, block: CodeBlock) {
  try {
    Deno.removeSync(folder, { recursive: true });
  } catch (e) {}

  Deno.chdir(COMPILER_DIR + "/..");

  const cmd = ["just", "init-project", folder];
  const { code, err, output } = await runShell(cmd);

  if (code > 0) {
    console.log("Init project failed");
    exit(err);
  }

  // Delete app.brg otherwise it may conflict with other definitions
  Deno.removeSync(folder + "/app.brg");

  // Switch to the test folder
  Deno.chdir(folder);

  // Create test files
  const files = splitInFiles(block.code);
  for (const file of files) {
    Deno.writeTextFileSync(file.filename, file.contents);
  }
}

export async function buildAndRunProject() {
  // Run compiler
  {
    const { code, err } = await runShell([BIN, "build"]);

    if (code === 0 && err) {
      console.log(err);
      exit("stopping because of debug output");
    }

    if (code > 0) {
      console.log("borgo build failed");
      exit(err);
    }
  }

  // Run gofumpt, doesn't matter if it fails
  const fmt = Deno.run({ cmd: ["gofumpt", "-w", "."] });
  await fmt.status();

  // Run go compiler
  const { code, output, err } = await runShell(["go", "run", "."]);

  if (code > 0) {
    console.log("go compiler failed");
    console.log(output);
    exit(err);
  }

  return output;
}

function appendGoSource(output: string) {
  // Append go source code to expectation output
  const source = Deno.readTextFileSync("user.go");
  return [output, source].join("\n---\n");
}

function replaceUnboundVars(output: string) {
  // Replace all unbound vars with a stable number, so that snapshots don't get updated when there are inference changes that don't affect the end result
  return output.replaceAll(/"Var": (\d+)/gm, (match, var_n) => {
    if (var_n == "-1") {
      console.error("Dummy unbound variable -1 found");
      Deno.exit(1);
    }

    return `"Var": 99`;
  });
}

export function decode(s: any) {
  return new TextDecoder().decode(s);
}

export function slugify(text: string) {
  return text
    .toString()
    .normalize("NFKD")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\_/g, "-")
    .replace(/\-\-+/g, "-")
    .replace(/\-$/g, "");
}

function inline(text: string) {
  return text
    .split("  ") // remove tabs
    .join("")
    .split("\n")
    .join(" ");
}
