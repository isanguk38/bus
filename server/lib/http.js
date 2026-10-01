export class ApiError extends Error {
  constructor(message, { status = 502, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function buildUrl(base, operation, params) {
  const url = new URL(`${base}/${operation}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

// 공공데이터포털은 JSON을 요청해도 인증·한도 오류는 XML로 돌려주는 경우가 있어 둘 다 처리한다.
export async function fetchJson(url, { timeoutMs = 10_000 } = {}) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? '응답 시간 초과' : err.message;
    throw new ApiError(`외부 API 요청 실패: ${reason}`);
  }
  const text = await res.text();
  if (!res.ok) throw new ApiError(`외부 API 오류 (HTTP ${res.status})`);
  try {
    return JSON.parse(text);
  } catch {
    const reason = text.match(/<(?:returnAuthMsg|errMsg|headerMsg)>([^<]+)</)?.[1] ?? text.slice(0, 120);
    throw new ApiError(`외부 API 응답 오류: ${reason}`);
  }
}

export function toArray(value) {
  if (value == null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}
