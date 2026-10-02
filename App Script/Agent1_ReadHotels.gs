/**
 * Agent 1: đọc danh sách khách sạn từ sheet.
 * Bỏ qua các dòng đã có status = "done" để không xử lý lại.
 */

function readHotelRows_(sheet) {
  var values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return { headers: values[0] || [], rows: [] };
  }

  var headers = values[0].map(function (h) { return String(h).trim(); });
  var statusColIndex = headers.indexOf('status');

  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var status = statusColIndex >= 0
      ? String(values[i][statusColIndex] || '').trim().toLowerCase()
      : '';

    if (status === STATUS_DONE) {
      continue;
    }

    var hotel = {};
    headers.forEach(function (key, index) {
      hotel[key] = values[i][index];
    });

    rows.push({ rowNumber: i + 1, hotel: hotel });
  }

  return { headers: headers, rows: rows };
}
