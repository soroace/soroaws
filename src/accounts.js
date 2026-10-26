const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_FILE = path.join(ROOT, "accounts.json");
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

/**
 * 将 AWS_ACCOUNTS_FILE 解析为绝对路径（相对路径按项目根解析）
 * @param {string} [filePath] - 配置的文件路径
 * @returns {string} 绝对路径
 */
function resolveAccountsFile(filePath) {
  if (!filePath) return DEFAULT_FILE;
  return path.isAbsolute(filePath) ? filePath : path.resolve(ROOT, filePath);
}

/**
 * 归一化并校验账号配置
 * @param {unknown} input - JSON 解析后的原始结构
 * @returns {{accounts: Array, errors: string[]}} accounts: [{name, enabled, credentials, regions}]
 */
function normalizeAccounts(input) {
  if (!Array.isArray(input)) {
    return { accounts: [], errors: ["账号配置必须是数组"] };
  }
  if (input.length === 0) {
    return { accounts: [], errors: ["账号配置为空，至少配置 1 个账号"] };
  }

  const errors = [];
  const seen = new Set();
  const accounts = [];

  input.forEach((item, index) => {
    const label = `第 ${index + 1} 个账号`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${label}格式不正确`);
      return;
    }

    const name = typeof item.name === "string" ? item.name.trim() : "";
    const nameLabel = name ? `${label}（${name}）` : label;
    if (!NAME_RE.test(name)) {
      errors.push(
        `${label}的 name 缺失或格式不合法（1-32 位字母/数字/下划线/连字符）`
      );
    } else if (seen.has(name)) {
      errors.push(`账号名 "${name}" 重复`);
    } else {
      seen.add(name);
    }

    const enabled = item.enabled !== false;
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
      errors.push(`${nameLabel}的 enabled 必须是布尔值`);
    }

    for (const field of ["accessKeyId", "secretAccessKey"]) {
      if (item[field] !== undefined && typeof item[field] !== "string") {
        errors.push(`${nameLabel}的 ${field} 必须是字符串`);
      }
    }

    const accessKeyId =
      typeof item.accessKeyId === "string" ? item.accessKeyId.trim() : "";
    const secretAccessKey =
      typeof item.secretAccessKey === "string" ? item.secretAccessKey.trim() : "";
    // 禁用账号允许凭证为空（例如密钥已失效但想保留配置），启用账号必须填写
    if (enabled) {
      if (!accessKeyId) errors.push(`${nameLabel}缺少 accessKeyId`);
      if (!secretAccessKey) errors.push(`${nameLabel}缺少 secretAccessKey`);
    }

    const regions = Array.isArray(item.regions)
      ? [
          ...new Set(
            item.regions
              .map((region) => (typeof region === "string" ? region.trim() : ""))
              .filter(Boolean)
          ),
        ]
      : [];
    // 禁用账号允许 regions 为空（不参与检测），启用账号必须至少配置一个区域
    if (enabled && regions.length === 0) {
      errors.push(`${nameLabel}的 regions 为空或格式不正确`);
    }
    const invalidRegion = regions.find((region) => !REGION_RE.test(region));
    if (invalidRegion) {
      errors.push(
        `${nameLabel}含无效区域名 "${invalidRegion}"，应形如 ap-northeast-1`
      );
    }

    accounts.push({
      name,
      enabled,
      credentials: { accessKeyId, secretAccessKey },
      regions,
    });
  });

  return { accounts, errors };
}

/**
 * 读取账号配置文件并校验
 * @param {string} [filePath] - 配置文件路径（默认项目根 accounts.json）
 * @returns {{accounts: Array, file: string, errors: string[]}}
 */
function loadAccounts(filePath) {
  const file = resolveAccountsFile(filePath);

  let raw;
  try {
    // 去掉 UTF-8 BOM：Windows 记事本等编辑器保存的文件可能带 BOM，会让 JSON.parse 失败
    raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF+/, "");
  } catch (err) {
    return {
      accounts: [],
      file,
      errors: [`无法读取账号配置文件 ${file}: ${err.code || err.message}`],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      accounts: [],
      file,
      errors: [`账号配置文件不是合法 JSON: ${err.message}`],
    };
  }

  const { accounts, errors } = normalizeAccounts(parsed);
  return { accounts, file, errors };
}

module.exports = {
  loadAccounts,
  normalizeAccounts,
  resolveAccountsFile,
};
