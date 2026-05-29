require("dotenv").config();
const password = encodeURIComponent(process.env.DB_PASSWORD);

// const MONGODB_URI = `mongodb+srv://demoloopio_db_user:${password}@demoloop.3y5slna.mongodb.net/demoloop?retryWrites=true&w=majority&appName=DemoLoop`;
const MONGODB_URI = `mongodb://localhost:27017/demoloop`;

module.exports = { MONGODB_URI };
