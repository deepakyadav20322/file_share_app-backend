const nodemailer = require("nodemailer");
module.exports = async ({ from, to, subject, text, html}) => {
    console.log("html of mail----> ",html)
        let transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: false, // true for 465, false for other ports
            auth: {
                user: process.env.MAIL_USER, 
                pass: process.env.MAIL_PASSWORD, 
            },
        });

        // send mail with defined transport object
    let info = await transporter.sendMail({
        from: `DocWave <${from}>`, // sender address
        to: to, // list of receivers
        subject: subject, // Subject line
        text: text, // plain text body
        html: html, // html body
    });
}