import mongoose, { Schema } from 'mongoose';
const appSettingSchema = new Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        maxlength: 120,
    },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String, default: null, maxlength: 500 },
}, { timestamps: true });
export const AppSettingModel = mongoose.models.AppSetting ??
    mongoose.model('AppSetting', appSettingSchema);
