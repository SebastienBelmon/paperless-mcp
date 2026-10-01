import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  assertAbsolutePath,
  assertWithinUploadLimit,
  getMaxUploadBytes,
  isPathAllowed,
  parseUploadPaths,
  resolveAllowedDirs,
  resolveExistingPath,
} from "./filePath";

const MB = 1024 * 1024;
const { win32, posix } = path;

function withMaxUploadMb<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.PAPERLESS_MCP_MAX_UPLOAD_MB;
  if (value === undefined) {
    delete process.env.PAPERLESS_MCP_MAX_UPLOAD_MB;
  } else {
    process.env.PAPERLESS_MCP_MAX_UPLOAD_MB = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.PAPERLESS_MCP_MAX_UPLOAD_MB;
    } else {
      process.env.PAPERLESS_MCP_MAX_UPLOAD_MB = previous;
    }
  }
}

describe("getMaxUploadBytes", () => {
  test("defaults to 100MB when unset", () => {
    assert.equal(withMaxUploadMb(undefined, getMaxUploadBytes), 100 * MB);
  });

  test("reads the limit in megabytes at call time", () => {
    assert.equal(withMaxUploadMb("500", getMaxUploadBytes), 500 * MB);
    assert.equal(withMaxUploadMb("1.5", getMaxUploadBytes), 1.5 * MB);
    assert.equal(withMaxUploadMb("1", getMaxUploadBytes), 1 * MB);
  });

  test("0 means no limit", () => {
    assert.equal(withMaxUploadMb("0", getMaxUploadBytes), Infinity);
  });

  test("falls back to 100MB for values that are not a non-negative number", () => {
    for (const value of ["abc", "-1", "", "  ", "Infinity", "NaN", "10MB"]) {
      assert.equal(
        withMaxUploadMb(value, getMaxUploadBytes),
        100 * MB,
        JSON.stringify(value)
      );
    }
  });
});

describe("assertWithinUploadLimit", () => {
  test("names the variable in the error", () => {
    withMaxUploadMb("2", () => {
      assert.throws(() => assertWithinUploadLimit(3 * MB), {
        message:
          "File size (3MB) exceeds maximum allowed size (2MB). Set PAPERLESS_MCP_MAX_UPLOAD_MB to change the limit (0 = unlimited).",
      });
      assert.doesNotThrow(() => assertWithinUploadLimit(2 * MB));
    });
  });

  test("never throws when the limit is disabled", () => {
    withMaxUploadMb("0", () => {
      assert.doesNotThrow(() => assertWithinUploadLimit(10 * 1024 * MB));
    });
  });
});

describe("assertAbsolutePath", () => {
  test("accepts Windows drive and UNC paths with the win32 path API", () => {
    assert.doesNotThrow(() => assertAbsolutePath("Z:\\Manuels\\Shéma.pdf", win32));
    assert.doesNotThrow(() =>
      assertAbsolutePath("\\\\serveur\\partage\\Manuels\\Shéma.pdf", win32)
    );
  });

  test("rejects relative paths, and Windows paths with the posix path API", () => {
    assert.throws(() => assertAbsolutePath("Manuels\\x.pdf", win32), {
      message: "file_path must be an absolute path",
    });
    assert.throws(() => assertAbsolutePath("Z:\\Manuels\\x.pdf", posix), {
      message: "file_path must be an absolute path",
    });
    assert.doesNotThrow(() => assertAbsolutePath("/var/uploads/x.pdf", posix));
  });
});

describe("parseUploadPaths", () => {
  test("splits on the platform delimiter without breaking Windows drive letters", () => {
    assert.equal(win32.delimiter, ";");
    assert.deepEqual(
      parseUploadPaths("Z:\\Manuels;D:\\Scans\\Inbox", win32),
      ["Z:\\Manuels", "D:\\Scans\\Inbox"]
    );
    assert.deepEqual(
      parseUploadPaths("\\\\serveur\\partage\\Manuels", win32),
      ["\\\\serveur\\partage\\Manuels"]
    );
  });

  test("splits on ':' for posix", () => {
    assert.equal(posix.delimiter, ":");
    assert.deepEqual(parseUploadPaths("/var/uploads:/tmp/scans", posix), [
      "/var/uploads",
      "/tmp/scans",
    ]);
  });

  test("ignores empty entries and an unset value", () => {
    assert.deepEqual(parseUploadPaths(undefined, posix), []);
    assert.deepEqual(parseUploadPaths("", posix), []);
    assert.deepEqual(parseUploadPaths("/a::/b:", posix), ["/a", "/b"]);
  });
});

describe("isPathAllowed", () => {
  describe("Windows mapped drive", () => {
    const allowed = ["Z:\\Manuels"];

    test("accepts files inside the allowed folder, accents included", () => {
      assert.ok(
        isPathAllowed("Z:\\Manuels\\Axopar 37 Shéma électrique B7.pdf", allowed, win32)
      );
      assert.ok(isPathAllowed("Z:\\Manuels\\Sous-dossier\\x.pdf", allowed, win32));
      assert.ok(isPathAllowed("Z:\\Manuels", allowed, win32));
    });

    test("rejects other folders and look-alike prefixes", () => {
      assert.ok(!isPathAllowed("Z:\\Autre\\x.pdf", allowed, win32));
      assert.ok(!isPathAllowed("Z:\\Manuels-evil\\x.pdf", allowed, win32));
      assert.ok(!isPathAllowed("Z:\\Manuels\\..\\Autre\\x.pdf", allowed, win32));
      assert.ok(!isPathAllowed("Y:\\Manuels\\x.pdf", allowed, win32));
    });

    test("compares case-insensitively", () => {
      assert.ok(isPathAllowed("z:\\manuels\\x.pdf", allowed, win32));
      assert.ok(isPathAllowed("Z:\\MANUELS\\x.pdf", allowed, win32));
      assert.ok(isPathAllowed("Z:\\Manuels\\x.pdf", ["z:\\MANUELS"], win32));
    });

    test("tolerates forward slashes and a trailing separator", () => {
      assert.ok(isPathAllowed("Z:\\Manuels\\x.pdf", ["Z:\\Manuels\\"], win32));
      assert.ok(isPathAllowed("Z:/Manuels/x.pdf", allowed, win32));
    });
  });

  describe("Windows UNC share", () => {
    const allowed = ["\\\\serveur\\partage\\Manuels"];

    test("accepts files inside the allowed share folder", () => {
      assert.ok(
        isPathAllowed("\\\\serveur\\partage\\Manuels\\Shéma.pdf", allowed, win32)
      );
    });

    test("rejects other folders, other shares and other servers", () => {
      assert.ok(
        !isPathAllowed("\\\\serveur\\partage\\Autre\\x.pdf", allowed, win32)
      );
      assert.ok(
        !isPathAllowed("\\\\serveur\\autre\\Manuels\\x.pdf", allowed, win32)
      );
      assert.ok(
        !isPathAllowed("\\\\autre\\partage\\Manuels\\x.pdf", allowed, win32)
      );
    });

    test("matches a file whose real path was resolved to UNC against an allowed dir resolved the same way", () => {
      const resolvedAllowed = ["\\\\serveur\\partage\\Manuels"];
      const resolvedFile = "\\\\serveur\\partage\\Manuels\\Axopar 37 Shéma électrique B7.pdf";
      assert.ok(isPathAllowed(resolvedFile, resolvedAllowed, win32));
    });
  });

  describe("posix", () => {
    const allowed = ["/var/uploads"];

    test("accepts the directory itself and anything below it", () => {
      assert.ok(isPathAllowed("/var/uploads", allowed, posix));
      assert.ok(isPathAllowed("/var/uploads/a/b.pdf", allowed, posix));
      assert.ok(isPathAllowed("/var/uploads/..hidden.pdf", allowed, posix));
    });

    test("rejects siblings, prefixes and parents", () => {
      assert.ok(!isPathAllowed("/var/uploads-evil/a.pdf", allowed, posix));
      assert.ok(!isPathAllowed("/var/other/a.pdf", allowed, posix));
      assert.ok(!isPathAllowed("/var", allowed, posix));
      assert.ok(!isPathAllowed("/var/uploads/../secret.pdf", allowed, posix));
    });

    test("is case-sensitive", () => {
      assert.ok(!isPathAllowed("/VAR/uploads/a.pdf", allowed, posix));
    });

    test("accepts a path matching any of several directories", () => {
      assert.ok(isPathAllowed("/tmp/scans/a.pdf", ["/var/uploads", "/tmp/scans"], posix));
    });
  });
});

describe("resolveExistingPath", () => {
  const NFC = (value: string) => value.normalize("NFC");
  const NFD = (value: string) => value.normalize("NFD");
  let root: string;

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "paperless-mcp-resolve-")));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("the accented test names really differ between NFC and NFD", () => {
    assert.notEqual(NFC("Shéma"), NFD("Shéma"));
  });

  test("resolves an existing path as given", async () => {
    const file = join(root, "plain.pdf");
    writeFileSync(file, "x");
    assert.equal(await resolveExistingPath(file), file);
  });

  test("finds a file stored in NFD when asked in NFC", async () => {
    const onDisk = join(root, NFD("Shéma électrique.pdf"));
    writeFileSync(onDisk, "x");
    assert.equal(
      await resolveExistingPath(join(root, NFC("Shéma électrique.pdf"))),
      realpathSync(onDisk)
    );
  });

  test("finds a file stored in NFC when asked in NFD", async () => {
    const onDisk = join(root, NFC("Façade.pdf"));
    writeFileSync(onDisk, "x");
    assert.equal(
      await resolveExistingPath(join(root, NFD("Façade.pdf"))),
      realpathSync(onDisk)
    );
  });

  test("finds a file inside a folder stored in NFD when asked in NFC", async () => {
    const folder = join(root, NFD("Manuels é"));
    mkdirSync(folder);
    const onDisk = join(folder, "a.pdf");
    writeFileSync(onDisk, "x");
    assert.equal(
      await resolveExistingPath(join(root, NFC("Manuels é"), "a.pdf")),
      realpathSync(onDisk)
    );
  });

  test("finds a file when the folder and the file use different normalizations", async () => {
    const folder = join(root, NFD("Dossier é"));
    mkdirSync(folder);
    const onDisk = join(folder, NFC("Reçu é.pdf"));
    writeFileSync(onDisk, "x");

    for (const asked of [
      join(root, NFC("Dossier é"), NFC("Reçu é.pdf")),
      join(root, NFD("Dossier é"), NFD("Reçu é.pdf")),
    ]) {
      assert.equal(await resolveExistingPath(asked), realpathSync(onDisk));
    }
  });

  test("still resolves symlinks", async () => {
    const target = join(root, "target.pdf");
    const link = join(root, "link.pdf");
    writeFileSync(target, "x");
    try {
      symlinkSync(target, link);
    } catch {
      return;
    }
    assert.equal(await resolveExistingPath(link), target);
  });

  test("reports the requested path when nothing matches", async () => {
    const missing = join(root, NFC("Absent é.pdf"));
    await assert.rejects(() => resolveExistingPath(missing), {
      message: `File not found: ${missing} (tried the path as given, NFC and NFD forms, and a directory listing of the parent folder)`,
    });
  });

  test("does not leak sibling names or parents in the error", async () => {
    mkdirSync(join(root, "secrets"));
    writeFileSync(join(root, "secrets", "passwords.txt"), "x");
    const missing = join(root, "secrets", "absent.pdf");

    await assert.rejects(() => resolveExistingPath(missing), (error: Error) => {
      assert.ok(!error.message.includes("passwords.txt"));
      return true;
    });
  });

  test("fails cleanly when no ancestor exists, down to the root", async () => {
    await assert.rejects(
      () => resolveExistingPath(join(root, "no", "such", "folder", "x.pdf")),
      { message: /^File not found: / }
    );
  });
});

describe("resolveAllowedDirs", () => {
  let root: string;

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "paperless-mcp-allowed-")));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("resolves symlinks and accent normalization of existing directories", async () => {
    const real = join(root, "Scans é".normalize("NFD"));
    mkdirSync(real);
    const link = join(root, "link");
    try {
      symlinkSync(real, link);
    } catch {
      return;
    }

    assert.deepEqual(
      await resolveAllowedDirs([join(root, "Scans é".normalize("NFC")), link]),
      [real, real]
    );
  });

  test("keeps a directory that does not exist as given", async () => {
    const missing = join(root, "not-there");
    assert.deepEqual(await resolveAllowedDirs([missing]), [missing]);
  });
});
