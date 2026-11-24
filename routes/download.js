const router = require('express').Router();
const path = require('path');
const File = require('../models/file');
const rateLimit = require('../services/rateLimit');
const { isUuid } = require('../services/abuseGuard');

router.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));

router.get('/:uuid', async (req, res) => {
   try {
      // Extract link and get file from storage send download stream
      const file = isUuid(req.params.uuid) ? await File.findOne({ uuid: req.params.uuid }) : null;
      // Link expired
      if(!file) {
           return res.render('download', { error: 'Link has been expired.'});
      }
      // Always a download, never rendered in the browser.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.download(path.join(__dirname, '..', file.path), (err) => {
        if (err && !res.headersSent) res.render('download', { error: 'Link has been expired.'});
      });
   } catch (err) {
      res.render('download', { error: 'Something went wrong.'});
   }
});


module.exports = router;
