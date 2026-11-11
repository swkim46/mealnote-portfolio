import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ACTIVE_VERSION = 'v4'
const EXPECTED_LOCKS = {
  v1: 'cac627b73a1e61057c66b3772d28fb89d1811a4c88645e8015664aab302a29a8',
  v2: '4869e8fb43337dfcddf8759e9e394d51256ae3c115e4b64b16194ec08727c0ae',
  v3: '701f92a3248b16c19839e0ce3c99177eacab35a63b2f76fd86a4497809a5821b',
  v4: '5c03a483aa52f83558a94c12c2eda5e0dea694a1b1b2bce75685a5665394fedb',
}
const SOURCE_SHA256S = {
  v1: '32168348504b5e522ca2e77494731aa84755b49c57858d39af29017b1ceda638',
  v2: '32168348504b5e522ca2e77494731aa84755b49c57858d39af29017b1ceda638',
  v3: 'ba8c8a977f31ea284b170357fdd7e4990134a2e1ebbd78755f2b3b09f18582b6',
  v4: 'ba8c8a977f31ea284b170357fdd7e4990134a2e1ebbd78755f2b3b09f18582b6',
}
const argv = process.argv.slice(2)
const appRoot = argv[0] === '--root' && argv[1]
  ? resolve(argv[1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = (data) => createHash('sha256').update(data).digest('hex')

try {
  let activeLock
  let count = 0
  for (const [version, expectedHash] of Object.entries(EXPECTED_LOCKS)) {
    const versionRoot = resolve(appRoot, 'brand/fitory', version)
    const raw = readFileSync(resolve(versionRoot, 'asset-lock.json'))
    if (sha(raw) !== expectedHash) throw new Error(`${version} asset-lock.json changed; do not refresh the lock to accept a replacement image`)
    const lock = JSON.parse(raw.toString('utf8'))
    if (lock.version !== version || lock.sourceSha256 !== SOURCE_SHA256S[version]) throw new Error(`${version} source anchor mismatch`)
    for (const [name, info] of Object.entries(lock.files)) {
      if (sha(readFileSync(resolve(versionRoot, name))) !== info.sha256) throw new Error(`frozen asset changed: ${version}/${name}`)
      count++
    }
    if (version === ACTIVE_VERSION) activeLock = lock
  }
  for (const [name, asset] of Object.entries(activeLock.public)) {
    const actual = readFileSync(resolve(appRoot, 'public', name))
    if (sha(actual) !== activeLock.files[asset].sha256) throw new Error(`public/${name} diverged from the frozen asset; run npm run brand:install`)
  }
  console.log(`FITORY ${ACTIVE_VERSION} verified: ${count} frozen files and ${Object.keys(activeLock.public).length} public assets`)
} catch (error) {
  console.error(`FITORY asset check failed: ${error.message}`)
  process.exitCode = 1
}
