const share = require('../../utils/share');
Page({ ...require('../../utils/receipt-page')(), onShareAppMessage: share.onShareAppMessage, onShareTimeline: share.onShareTimeline });
