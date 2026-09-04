'use strict';

const fs = require('fs');
const path = require('path');

function removeIfExists(target, fsImpl = fs) {
  try { fsImpl.rmSync(target, { recursive: true, force: true }); } catch {}
}

function replaceDirectory(sourceDir, targetDir, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const temp = `${targetDir}.txn.${process.pid}`;
  removeIfExists(temp, fsImpl);
  fsImpl.cpSync(sourceDir, temp, { recursive: true });
  if (!fsImpl.existsSync(targetDir)) {
    fsImpl.renameSync(temp, targetDir);
    return;
  }
  const old = `${targetDir}.old.${process.pid}`;
  removeIfExists(old, fsImpl);
  try {
    fsImpl.renameSync(targetDir, old);
  } catch {
    removeIfExists(targetDir, fsImpl);
    fsImpl.cpSync(temp, targetDir, { recursive: true });
    removeIfExists(temp, fsImpl);
    return;
  }
  try {
    fsImpl.renameSync(temp, targetDir);
  } catch (error) {
    try { fsImpl.renameSync(old, targetDir); } catch {}
    removeIfExists(temp, fsImpl);
    throw error;
  }
  removeIfExists(old, fsImpl);
}

function replaceCatalogFiles(sourceDir, catalogFiles, options = {}) {
  const fsImpl = options.fsImpl || fs;
  for (const file of Object.values(catalogFiles)) {
    const staged = path.join(sourceDir, path.basename(file));
    const temp = `${file}.txn.${process.pid}`;
    fsImpl.copyFileSync(staged, temp);
    fsImpl.renameSync(temp, file);
  }
}

function copyCatalogFiles(targetDir, catalogFiles, options = {}) {
  const fsImpl = options.fsImpl || fs;
  fsImpl.mkdirSync(targetDir, { recursive: true });
  for (const file of Object.values(catalogFiles)) {
    fsImpl.copyFileSync(file, path.join(targetDir, path.basename(file)));
  }
}

function backupDirectory(target, projectDir, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const dist = path.join(projectDir, 'dist');
  if (fsImpl.existsSync(dist)) fsImpl.cpSync(dist, target, { recursive: true });
}

module.exports = { removeIfExists, replaceDirectory, replaceCatalogFiles, copyCatalogFiles, backupDirectory };
