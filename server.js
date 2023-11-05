
require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const path = require('path');
const cors = require('cors');

const corsOptions = {
    origin: process.env.ALLOWED_CLIENTS.split(',')
    // ['http://localhost:3000', 'http://localhost:5000', 'http://localhost:3300']
  }

app.use(cors());
app.use(express.static('public'));

//connect to database....
const connectDB = require('./config/db');
connectDB();

app.use(express.json());

//assingn template engine...
app.set('views', path.join(__dirname, '/views'));
app.set('view engine', 'ejs');

// Routes 
app.use('/api/files', require('./routes/files'));
app.use('/files', require('./routes/show'));
app.use('/files/download', require('./routes/download'));


//--------------------------  Logic for Delete 24 hours old uploaded files  ------------------------------------//
const File = require('./models/file');
const deleteOldFiles = async()=>{
  try {
    const oldTimestamp = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const deleteResult = await File.deleteMany({ createdAt: { $lt: oldTimestamp } });
   
    console.log(`Deleted ${deleteResult.deletedCount} old files.`);
   
  } catch (error) {
    console.error('An error occurred during cron job:-', error);
  }
}

const cron = require('node-cron');
cron.schedule('0 0 * * *', () => {
  deleteOldFiles();
 
});




app.listen(PORT, console.log(`Listening on ports ${PORT}.`));