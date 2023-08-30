const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const File = require('../models/file');
const { v4: uuidv4 } = require('uuid');

let storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/') ,
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
              cb(null, uniqueName)
    } ,
});

let upload = multer({ storage, limits:{ fileSize: 1000000 * 100 }, }).single('myfile'); //100mb

router.post('/', (req, res) => {
  
    upload(req, res, async (err) => {
      if (err) {
        
        return res.status(500).send({ error: err.message });
      }
      console.log(req.file)
        const file = new File({
            filename: req.file.filename,
            uuid: uuidv4(),
            path: req.file.path,
            size: req.file.size
        });
        const response = await file.save();
        console.log(response);
        res.status(200).json({ file: `${process.env.LIVE_APP_BASE_URL}/files/${response.uuid}` });
      });
});

router.post('/send', async (req, res) => {
  console.log("hhhhhhhh------",req.body)
  const { uuid, emailTo, emailFrom } = req.body;
  if(!uuid || !emailTo || !emailFrom) {
      return res.status(422).send({ error: 'All fields are required except expiry.'});
  }
  // Get data from db 
  try {
    console.log('000000000000000000000')
    const file = await File.findOne({ uuid: uuid });
    console.log(file,"kkkkkkkkkkkkkkkkkkkk")
    const sender = file.receiver
    console.log(sender)
    if(sender) {
      return res.status(200).json({ message: 'Email already sent once.'});
    }
    file.sender = emailFrom;
    file.receiver = emailTo;
    const response = await file.save();
    // send mail
    console.log("mail se pahle......")
    const sendMail = require('../services/mailService');
    sendMail({
      from: emailFrom,
      to: emailTo,
      subject: 'DocWave file sharing',
      text: `${emailFrom} shared a file with you.`,
      html: require('../services/emailTemplate')({
                emailFrom, 
                downloadLink: `${process.env.LIVE_APP_BASE_URL}/${file.uuid}?source=email` ,
                size: parseInt(file.size/1000) + ' KB',
                expires: '24 hours'
            })
    }).then(() => {
      console.log('res send to client')
      return res.status(200).json({success: true,message:'Email send successfully'});
    }).catch(err => {
      console.log(err);
      return res.status(500).json({error: 'Error in email sending.'});
    });
    console.log("mail ke bad......");
} catch(err) {
  return res.status(500).send({ error: 'Something went wrong.'});
}

});

module.exports = router;