/**
 * Agent 3: viết brief chiến dịch dựa trên khách sạn + buyer persona đã chọn.
 */

function writeCampaignBrief_(hotel, persona) {
  var systemPrompt =
    'Bạn là campaign strategist cho ngành khách sạn/du lịch. ' +
    'Viết brief chiến dịch ngắn gọn, rõ ràng để các sub-agent khác dùng viết nội dung từng nền tảng.';

  var extraRules = getBriefExtraRules_();
  if (extraRules) {
    systemPrompt += '\n\nQuy tắc bổ sung (do người vận hành cấu hình trong sheet Rules):\n' + extraRules;
  }

  var userPrompt = [
    buildHotelContextText_(hotel),
    '',
    'Buyer persona mục tiêu: ' + persona.persona,
    'Lý do chọn persona: ' + persona.reason,
    'Tone gợi ý: ' + persona.tone,
    '',
    'Hãy viết brief chiến dịch marketing gồm:',
    '1. Thông điệp chính (key message)',
    '2. 3 điểm bán hàng (selling points) nhắm vào persona này',
    '3. Tone & giọng văn',
    '4. Call-to-action đề xuất',
    '',
    'Trả lời bằng văn bản thường, có đánh số, không cần JSON.',
  ].join('\n');

  return callClaude_(systemPrompt, userPrompt, 500);
}
