/**
 * Agent 4: điều phối sub-agent viết nội dung cho từng nền tảng (facebook, zalo, ...).
 * Chỉ dẫn viết nội dung (skill) cho mỗi platform không hard-code ở đây — được đọc linh động
 * từ sheet "Rules" (xem Rules.gs) để người vận hành tự thêm/sửa mà không cần sửa code.
 */

function generatePlatformContent_(hotel, persona, brief, platform) {
  var instruction = getPlatformSkill_(platform);

  var systemPrompt =
    'Bạn là social media copywriter cho ngành khách sạn/du lịch, ' +
    'viết đúng format và văn hoá riêng của từng nền tảng.';

  var userPrompt = [
    'Persona mục tiêu: ' + persona.persona + ' (tone: ' + persona.tone + ')',
    '',
    'Brief chiến dịch:',
    brief,
    '',
    buildHotelContextText_(hotel),
    '',
    'Viết 1 bài đăng cho nền tảng: ' + platform,
    instruction,
    '',
    'Chỉ trả về nội dung bài đăng hoàn chỉnh, không giải thích thêm.',
  ].join('\n');

  // 1200 token - đủ dư cho template Facebook 9 phần (hook, mô tả, giá, ghi chú, đoạn cảm xúc,
  // CTA, sign-off, hashtag) lẫn Zalo dài, tránh bị cắt cụt giữa chừng như 400 token cũ.
  return callClaude_(systemPrompt, userPrompt, 1200);
}

function runPlatformSubAgents_(hotel, persona, brief, platforms) {
  var contentMap = {};
  platforms.forEach(function (platform) {
    contentMap[platform] = generatePlatformContent_(hotel, persona, brief, platform);
  });
  return contentMap;
}
