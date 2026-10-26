const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_FILE = path.join(ROOT, "accounts.json");
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const CHECK_MODES = ["ping", "ping+tcp"];
const DEFAULT_CHECK = {
  mode: "ping",
  ports: [],
  tcpTimeoutMs: 3000,
  confirmRounds: 2,
  rotateOnTcpDown: false,
};

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
 * 归一化并校验单个账号的 check（检测方式）配置
 * @param {unknown} raw - accounts.json 中的 check 字段
 * @param {string} nameLabel - 用于错误信息的账号标识
 * @returns {{check: object, errors: string[]}}
 */
function normalizeCheck(raw, nameLabel) {
  const check = { ...DEFAULT_CHECK, ports: [] };

  if (raw === undefined) return { check, errors: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { check, errors: [`${nameLabel}的 check 必须是对象`] };
  }

  const errors = [];

  if (raw.mode !== undefined) {
    if (!CHECK_MODES.includes(raw.mode)) {
      errors.push(`${nameLabel}的 check.mode 必须是 ${CHECK_MODES.join(" / ")}`);
    } else {
      check.mode = raw.mode;
    }
  }

  if (raw.ports !== undefined) {
    if (!Array.isArray(raw.ports) || raw.ports.length === 0) {
      errors.push(`${nameLabel}的 check.ports 必须是非空数组`);
    } else {
      const ports = [...new Set(raw.ports)];
      const invalidPort = ports.find(
        (port) => !Number.isInteger(port) || port < 1 || port > 65535
      );
      if (invalidPort !== undefined) {
        errors.push(
          `${nameLabel}的 check.ports 含无效端口 "${invalidPort}"（应为 1-65535 的整数）`
        );
      } else {
        check.ports = ports;
      }
    }
  }

  if (check.mode !== "ping" && check.ports.length === 0 && raw.ports === undefined) {
    errors.push(
      `${nameLabel}启用 TCP 检测（check.mode=${check.mode}）时必须配置 check.ports`
    );
  }

  if (raw.tcpTimeoutMs !== undefined) {
    if (
      !Number.isInteger(raw.tcpTimeoutMs) ||
      raw.tcpTimeoutMs < 100 ||
      raw.tcpTimeoutMs > 30000
    ) {
      errors.push(`${nameLabel}的 check.tcpTimeoutMs 必须是 100-30000 的整数`);
    } else {
      check.tcpTimeoutMs = raw.tcpTimeoutMs;
    }
  }

  if (raw.confirmRounds !== undefined) {
    if (
      !Number.isInteger(raw.confirmRounds) ||
      raw.confirmRounds < 1 ||
      raw.confirmRounds > 10
    ) {
      errors.push(`${nameLabel}的 check.confirmRounds 必须是 1-10 的整数`);
    } else {
      check.confirmRounds = raw.confirmRounds;
    }
  }

  if (raw.rotateOnTcpDown !== undefined) {
    if (typeof raw.rotateOnTcpDown !== "boolean") {
      errors.push(`${nameLabel}的 check.rotateOnTcpDown 必须是布尔值`);
    } else {
      check.rotateOnTcpDown = raw.rotateOnTcpDown;
    }
  }

  return { check, errors };
}

/**
 * 归一化并校验账号配置
 * @param {unknown} input - JSON 解析后的原始结构
 * @returns {{accounts: Array, errors: string[]}} accounts: [{name, enabled, credentials, regions, check}]
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

    const { check, errors: checkErrors } = normalizeCheck(item.check, nameLabel);
    errors.push(...checkErrors);

    accounts.push({
      name,
      enabled,
      credentials: { accessKeyId, secretAccessKey },
      regions,
      check,
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
  DEFAULT_CHECK,
};
