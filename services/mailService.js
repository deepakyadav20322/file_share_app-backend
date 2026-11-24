const nodemailer = require("nodemailer");

// The From address is always SendAnyFile's own mailbox. A visitor-supplied address can only ever go in
// Reply-To, so nobody can send mail that appears to come from someone else.
module.exports = async ({ to, subject, text, html, replyTo }) => {
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
    await transporter.sendMail({
        from: `SendAnyFile <${process.env.MAIL_USER}>`, // sender address
        to: to, // list of receivers
        replyTo: replyTo, // optional: where replies should go
        subject: subject, // Subject line
        text: text, // plain text body
        html: html, // html body
    });
}
