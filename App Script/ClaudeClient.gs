/**
 * Lớp gọi Claude dùng chung cho tất cả agent — luôn qua Vertex AI Model Garden (billing dồn về
 * GCP), xem PLAN_vertex_ai_billing_draft.md. Không còn đường gọi Anthropic API trực tiếp/API key.
 */

var CLAUDE_MAX_RETRIES = 3;
var VERTEX_TOKEN_URL_ = 'https://oauth2.googleapis.com/token';
var VERTEX_TOKEN_CACHE_KEY_ = 'VERTEX_ACCESS_TOKEN';
var VERTEX_TOKEN_CACHE_SECONDS_ = 55 * 60; // token thật hạn 1h, cache ngắn hơn cho an toàn

function callClaude_(systemPrompt, userPrompt, maxTokens) {
  return callClaudeViaVertex_(systemPrompt, userPrompt, maxTokens);
}

function callClaudeViaVertex_(systemPrompt, userPrompt, maxTokens) {
  var accessToken = getVertexAccessToken_();
  var projectId = getVertexProjectId_();
  var region = getVertexRegion_();
  var model = getClaudeVertexModel_();

  var endpoint = 'https://' + region + '-aiplatform.googleapis.com/v1/projects/' + projectId +
    '/locations/' + region + '/publishers/anthropic/models/' + model + ':rawPredict';

  var payload = {
    anthropic_version: 'vertex-2023-10-16',
    max_tokens: maxTokens || 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'x-goog-user-project': projectId,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  return fetchClaudeWithRetry_(endpoint, options, 'Claude (Vertex AI)');
}

function fetchClaudeWithRetry_(endpoint, options, errorLabel) {
  var lastError = null;

  for (var attempt = 0; attempt <= CLAUDE_MAX_RETRIES; attempt++) {
    var response = UrlFetchApp.fetch(endpoint, options);
    var code = response.getResponseCode();
    var body = response.getContentText();

    if (code === 200) {
      return extractClaudeMessageText_(body);
    }

    if (code === 429 || code >= 500) {
      lastError = new Error(errorLabel + ' lỗi tạm thời (HTTP ' + code + '): ' + body);
      Utilities.sleep(1000 * Math.pow(2, attempt));
      continue;
    }

    throw new Error(errorLabel + ' lỗi (HTTP ' + code + '): ' + body);
  }

  throw lastError || new Error(errorLabel + ' thất bại sau nhiều lần thử lại');
}

function extractClaudeMessageText_(body) {
  var json = JSON.parse(body);
  return (json.content || [])
    .filter(function (block) { return block.type === 'text'; })
    .map(function (block) { return block.text; })
    .join('\n')
    .trim();
}

/**
 * Lấy access token GCP bằng JWT Bearer flow (service account) — không dùng ScriptApp.getOAuthToken_()
 * vì token đó gắn với người đang chạy script, ngắn hạn hơn, và không cần cấp quyền Vertex AI cho
 * từng người vận hành. Cache lại để không phải ký JWT + gọi token endpoint cho mỗi lần gọi Claude.
 */
function getVertexAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(VERTEX_TOKEN_CACHE_KEY_);
  if (cached) {
    return cached;
  }

  var serviceAccount = getVertexServiceAccountKey_();
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('VERTEX_SA_KEY_JSON thiếu client_email hoặc private_key.');
  }

  var nowSeconds = Math.floor(new Date().getTime() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var claimSet = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: VERTEX_TOKEN_URL_,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  var toSign = base64UrlEncode_(JSON.stringify(header)) + '.' + base64UrlEncode_(JSON.stringify(claimSet));
  var signatureBytes = Utilities.computeRsaSha256Signature(toSign, serviceAccount.private_key);
  var jwt = toSign + '.' + base64UrlEncodeBytes_(signatureBytes);

  var response = UrlFetchApp.fetch(VERTEX_TOKEN_URL_, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    },
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) {
    throw new Error('Lỗi lấy Vertex AI access token (HTTP ' + code + '): ' + body);
  }

  var accessToken = JSON.parse(body).access_token;
  cache.put(VERTEX_TOKEN_CACHE_KEY_, accessToken, VERTEX_TOKEN_CACHE_SECONDS_);
  return accessToken;
}

function base64UrlEncode_(text) {
  return Utilities.base64EncodeWebSafe(text).replace(/=+$/, '');
}

function base64UrlEncodeBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function extractJson_(text) {
  var cleaned = text.replace(/```json/gi, '```').split('```').join('').trim();
  var start = cleaned.indexOf('{');
  var end = cleaned.lastIndexOf('}');

  if (start === -1 || end === -1) {
    throw new Error('Không tìm thấy JSON trong phản hồi: ' + text);
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}
