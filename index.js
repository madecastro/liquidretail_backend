const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const { processImage } = require('./services/openaiService');
const { uploadToS3 } = require('./services/s3Service');
const Product = require('./models/Product');

const app = express();
const upload = multer({ dest: 'uploads/' });

mongoose.connect('mongodb://localhost:27017/catalogApp', { useNewUrlParser: true, useUnifiedTopology: true });

...