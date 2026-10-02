/**
 * Hàm tiện ích chung: quản lý cột trong sheet, lấy tên khách sạn.
 */

function ensureColumns_(sheet, headers, requiredColumns) {
  var columnMap = {};
  headers.forEach(function (name, index) {
    columnMap[name] = index + 1;
  });

  var updatedHeaders = headers.slice();
  var headerRowChanged = false;

  requiredColumns.forEach(function (name) {
    if (!columnMap[name]) {
      updatedHeaders.push(name);
      columnMap[name] = updatedHeaders.length;
      headerRowChanged = true;
    }
  });

  if (headerRowChanged) {
    sheet.getRange(1, 1, 1, updatedHeaders.length).setValues([updatedHeaders]);
  }

  return columnMap;
}

function getHotelName_(hotel) {
  return hotel.hotel_name || hotel.name || hotel.Hotel || 'Khách sạn';
}

// Dựng khối mô tả khách sạn dùng chung cho Agent 2/3/4 (thay JSON.stringify(hotel) đổ nguyên cục).
// Ưu tiên số 1: video_description/video_summary (do video-agent-service phân tích từ video thật -
// nguồn mô tả chính xác và giàu cảm xúc nhất). Các cột thủ công (destination/giai_doan/benefits_raw/
// booking_note) chỉ là thông tin BỔ SUNG, nối thêm chứ không thay thế phần video khi cả 2 cùng có.
// Nếu sheet không theo cấu trúc chuẩn này (không có field nào trong danh sách canonical) thì fallback
// nguyên JSON như cũ để không mất dữ liệu của các cột tự do khác.
function buildHotelContextText_(hotel) {
  var hasVideoContent = hotel['video_description'] && String(hotel['video_description']).trim() !== '';
  var canonicalKeys = ['ten_ks', 'gia', 'destination', 'giai_doan', 'benefits_raw', 'booking_note'];
  var hasAnyCanonicalField = hasVideoContent || canonicalKeys.some(function (key) {
    return hotel[key] !== undefined && hotel[key] !== null && String(hotel[key]).trim() !== '';
  });

  if (!hasAnyCanonicalField) {
    return 'Thông tin khách sạn:\n' + JSON.stringify(hotel, null, 2);
  }

  var lines = [];
  lines.push('Khách sạn: ' + (hotel['ten_ks'] || getHotelName_(hotel)));
  if (hotel['gia']) {
    lines.push('Giá: ' + hotel['gia']);
  }
  lines.push('');

  if (hasVideoContent) {
    lines.push('PHÂN TÍCH TỪ VIDEO (ưu tiên chính - nguồn mô tả khách sạn chính xác và giàu cảm xúc nhất, ưu tiên dùng nội dung này):');
    lines.push('- Mô tả: ' + hotel['video_description']);
    if (hotel['video_summary']) {
      lines.push('- Cảm xúc/trải nghiệm khách hàng: ' + hotel['video_summary']);
    }
    lines.push('');
  }

  var supplementFields = [
    ['destination', 'Điểm đến'],
    ['giai_doan', 'Giai đoạn/thời gian áp dụng'],
    ['benefits_raw', 'Ưu đãi/tiện ích'],
    ['booking_note', 'Ghi chú đặt phòng'],
  ];
  var supplementLines = [];
  supplementFields.forEach(function (pair) {
    var key = pair[0];
    var label = pair[1];
    if (hotel[key] !== undefined && hotel[key] !== null && String(hotel[key]).trim() !== '') {
      supplementLines.push('- ' + label + ': ' + hotel[key]);
    }
  });

  if (supplementLines.length > 0) {
    lines.push(hasVideoContent ? 'Thông tin bổ sung (kết hợp thêm với phần phân tích video ở trên):' : 'Thông tin khách sạn:');
    lines = lines.concat(supplementLines);
  }

  return lines.join('\n');
}
