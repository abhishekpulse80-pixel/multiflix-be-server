import mongoose, { Schema } from 'mongoose';
const feedbackSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    subject: {
        type: String,
        required: true,
        trim: true,
        maxlength: 200,
    },
    message: {
        type: String,
        required: true,
        trim: true,
        maxlength: 5000,
    },
    status: {
        type: String,
        enum: ['new', 'read', 'addressed'],
        default: 'new',
        index: true,
    },
    adminNotes: {
        type: String,
        trim: true,
        maxlength: 2000,
        default: '',
    },
}, { timestamps: true });
export const FeedbackModel = mongoose.models.Feedback ??
    mongoose.model('Feedback', feedbackSchema);
