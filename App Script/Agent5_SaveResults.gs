/**
 * Agent 5: lưu nội dung đã tạo (persona, brief, nội dung từng nền tảng) trở lại sheet.
 */

// Các cột người vận hành xem nhiều nhất - khi sheet chưa có (lần đầu chạy), ensureColumns_ sẽ
// tự tạo đúng theo thứ tự này trước, các cột khác nối tiếp sau (xem cách dùng trong
// Orchestrator.gs). Chỉ có tác dụng khi cột CHƯA tồn tại - không tự sắp xếp lại cột đã có sẵn.
var PRIORITY_COLUMNS_ = [
  'video_render_url',
  'video_srt',
  'zalo_copy',
  'facebook_copy',
  'buyer_persona',
  'persona_reason',
  'persona_tone',
  'campaign_brief',
  'status',
];

var REQUIRED_OUTPUT_COLUMNS_ = [
  'buyer_persona',
  'persona_reason',
  'persona_tone',
  'campaign_brief',
  'status',
  'last_run_at',
];

var FB_POST_COLUMNS_ = ['fb_post_status', 'fb_post_id', 'fb_post_at'];
var FB_INPUT_COLUMNS_ = ['drive_folder_url'];

var VIDEO_RENDER_COLUMNS_ = ['video_render_status', 'video_render_job_id', 'video_render_url', 'video_render_at'];
var VIDEO_INPUT_COLUMNS_ = ['video_drive_url', 'video_subtitle_srt', 'music_drive_url'];

var VIDEO_AGENT_INPUT_COLUMNS_ = ['video_folder_url'];
var VIDEO_AGENT_OUTPUT_COLUMNS_ = [
  'video_description',
  'video_summary',
  'video_srt',
  'video_edit_script',
  'video_agent_status',
  'video_agent_job_id',
  'video_agent_at',
];

function saveHotelResult_(sheet, rowNumber, columnMap, result) {
  sheet.getRange(rowNumber, columnMap['buyer_persona']).setValue(result.persona.persona);
  sheet.getRange(rowNumber, columnMap['persona_reason']).setValue(result.persona.reason);
  sheet.getRange(rowNumber, columnMap['persona_tone']).setValue(result.persona.tone);
  sheet.getRange(rowNumber, columnMap['campaign_brief']).setValue(result.brief);

  Object.keys(result.platformContentMap).forEach(function (platform) {
    var colName = platform + '_copy';
    if (columnMap[colName]) {
      sheet.getRange(rowNumber, columnMap[colName]).setValue(result.platformContentMap[platform]);
    }
  });

  if (result.facebookPostResult && columnMap['fb_post_status']) {
    sheet.getRange(rowNumber, columnMap['fb_post_status']).setValue(result.facebookPostResult.status);
    sheet.getRange(rowNumber, columnMap['fb_post_id']).setValue(result.facebookPostResult.postId || '');
    sheet.getRange(rowNumber, columnMap['fb_post_at']).setValue(new Date());
  }

  if (result.videoRenderResult && columnMap['video_render_status']) {
    sheet.getRange(rowNumber, columnMap['video_render_status']).setValue(result.videoRenderResult.status);
    sheet.getRange(rowNumber, columnMap['video_render_job_id']).setValue(result.videoRenderResult.jobId || '');
    sheet.getRange(rowNumber, columnMap['video_render_at']).setValue(new Date());
  }

  sheet.getRange(rowNumber, columnMap['status']).setValue(STATUS_DONE);
  sheet.getRange(rowNumber, columnMap['last_run_at']).setValue(new Date());
}

function saveHotelError_(sheet, rowNumber, columnMap, error) {
  sheet.getRange(rowNumber, columnMap['status']).setValue(STATUS_ERROR_PREFIX + error.message);
  sheet.getRange(rowNumber, columnMap['last_run_at']).setValue(new Date());
}
