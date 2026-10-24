/**
 * tools/install.mjs —— 把 dsh-myosotis 装进本机 DSH
 *
 *   node tools/install.mjs            # 安装（默认 desktop profile）
 *   node tools/install.mjs --dry-run  # 只看要改什么，不动文件
 *   node tools/install.mjs --uninstall
 *   node tools/install.mjs --profile web-desktop
 *
 * 做的事（和 pnpm 的 link: 依赖等价，只是不需要跑包管理器）：
 *   1. 复制插件到 <DSH_HOME>/local-plugins/dsh-myosotis
 *   2. 在 profile 的 package.json 里加一条 link: 依赖 + bundles 条目（先备份）
 *   3. 在 profile/node_modules 里建一个目录链接
 *
 * 三步都是可逆的：--uninstall 撤掉 2、3；记忆文件本身不动。
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PKG = 'dsh-myosotis';
const SRC = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const uninstall = argv.includes('--uninstall');
const profileArg = argv.indexOf('--profile');
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');

/**
 * 选一个 profile：显式指定的优先，其次 desktop，再其次第一个可用的。
 * @returns {string} profile 名。
 */
function pickProfile() {
  if (profileArg !== -1 && argv[profileArg + 1]) return argv[profileArg + 1];
  const root = join(dshHome, 'profiles');
  const names = existsSync(root) ? readdirSync(root) : [];
  const usable = names.filter((name) => existsSync(join(root, name, 'package.json')));
  if (usable.includes('desktop')) return 'desktop';
  return usable[0] || 'desktop';
}

const profileName = pickProfile();
const profileDir = join(dshHome, 'profiles', profileName);
const pkgJsonPath = join(profileDir, 'package.json');
const installDir = join(dshHome, 'local-plugins', PKG);
const linkPath = join(profileDir, 'node_modules', PKG);

if (!existsSync(pkgJsonPath)) {
  console.error(`找不到 profile：${pkgJsonPath}`);
  process.exit(1);
}

const say = (message) => console.log(`${dryRun ? '[dry] ' : ''}${message}`);

/**
 * 读 JSON。
 * @param {string} path 路径。
 * @returns {any} 解析结果。
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * 写 JSON（两空格缩进 + 末尾换行，保持 diff 干净）。
 * @param {string} path 路径。
 * @param {any} data 数据。
 */
function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * 备份 profile 的 package.json。
 * @param {string} path 路径。
 */
function backup(path) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const destination = `${path}.bak-${stamp}`;
  if (!dryRun) copyFileSync(path, destination);
  say(`已备份 ${destination}`);
}

/**
 * 判断路径是不是链接。
 * @param {string} path 路径。
 * @returns {boolean} 是否链接。
 */
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 删除 profile 里的链接。 */
function removeLink() {
  if (!existsSync(linkPath) && !isLink(linkPath)) return;
  say(`删除链接 ${linkPath}`);
  if (!dryRun) rmSync(linkPath, { recursive: true, force: true });
}

/**
 * 增删 profile package.json 里的依赖与 bundle 条目。
 * @param {boolean} add true = 安装，false = 卸载。
 */
function patchJson(add) {
  const pkg = readJson(pkgJsonPath);
  pkg.dependencies = pkg.dependencies || {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  const bundles = (pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []);

  if (add) {
    if (!pkg.dependencies[PKG]) {
      pkg.dependencies[PKG] = 'link:' + installDir.replace(/\\/g, '/');
      say(`package.json → dependencies["${PKG}"] = link:${installDir}`);
    }
    if (!bundles.includes(PKG)) {
      bundles.push(PKG);
      say(`package.json → dsh.profile.bundles += ${PKG}`);
    }
  } else {
    if (pkg.dependencies[PKG]) {
      delete pkg.dependencies[PKG];
      say(`package.json → 移除 dependencies["${PKG}"]`);
    }
    const index = bundles.indexOf(PKG);
    if (index !== -1) {
      bundles.splice(index, 1);
      say('package.json → 移除 bundles 条目');
    }
  }
  if (!dryRun) writeJson(pkgJsonPath, pkg);
}

/** 复制插件本体。 */
function copyPlugin() {
  const files = ['package.json', 'cordis.patch.yml', 'README.md', 'lib'];
  say(`复制插件 → ${installDir}`);
  if (dryRun) return;
  mkdirSync(installDir, { recursive: true });
  for (const file of files) {
    const from = join(SRC, file);
    if (!existsSync(from)) continue;
    cpSync(from, join(installDir, file), { recursive: true });
  }
}

/** 在 profile/node_modules 下建目录链接。 */
function makeLink() {
  say(`建立链接 ${linkPath} → ${installDir}`);
  if (dryRun) return;
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true });
  rmSync(linkPath, { recursive: true, force: true });
  try {
    symlinkSync(installDir, linkPath, 'junction');
  } catch (error) {
    console.warn('  junction 失败，回退到 symlink：', error.message);
    symlinkSync(installDir, linkPath, 'dir');
  }
}

console.log(`DSH_HOME  ${dshHome}`);
console.log(`profile   ${profileName}`);
console.log('');

if (uninstall) {
  removeLink();
  patchJson(false);
  say(`（插件本体保留在 ${installDir}，需要的话手动删除）`);
  console.log('\n卸载完成，重启 DSH 生效。记忆文件不受影响。');
} else {
  backup(pkgJsonPath);
  copyPlugin();
  patchJson(true);
  makeLink();
  console.log('\n安装完成，重启 DSH 生效。');
  console.log('第一次使用：随便开个会话说一句「记住：我喜欢简洁的回复」，然后看 ~/.dsh/memory/MEMORY.md。');
}
