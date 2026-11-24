const router = require('express').Router();
const File = require('../models/file');
const rateLimit = require('../services/rateLimit');
const { isUuid } = require('../services/abuseGuard');

router.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));

router.get('/:uuid', async (req, res) => {
    try {
        const file = isUuid(req.params.uuid) ? await File.findOne({ uuid: req.params.uuid }) : null;
        // Link expired
        if(!file) {
            return res.render('download', { error: 'Link has been expired.'});
        }
        // return res.render('download', { uuid: file.uuid, fileName: file.filename, fileSize: file.size, downloadLink: `${process.env.APP_BASE_URL}/files/download/${file.uuid}` });
        return res.render('download', { uuid: file.uuid, fileName: file.filename, fileSize: file.size, downloadLink: `${process.env.LIVE_APP_BASE_URL}/files/download/${file.uuid}` });
    } catch(err) {
        return res.render('download', { error: 'Something went wrong.'});
    }
});


module.exports = router;
