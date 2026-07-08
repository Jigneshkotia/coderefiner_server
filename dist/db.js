import mongoose from 'mongoose';
export async function connectDb(uri) {
    console.log('Attempting to connect to MongoDB...');
    await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
    });
    console.log('Connected to MongoDB Atlas');
}
