import { FeedbackModel } from '../models/feedback.model.js';
export async function createFeedback(userId, body) {
    const feedback = await FeedbackModel.create({
        user: userId,
        subject: body.subject,
        message: body.message,
    });
    return feedback.toObject();
}
export async function listUserFeedback(userId, page, limit) {
    const filter = { user: userId };
    const [items, total] = await Promise.all([
        FeedbackModel.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        FeedbackModel.countDocuments(filter),
    ]);
    return { items, total, page, limit };
}
