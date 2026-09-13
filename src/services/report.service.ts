import mongoose from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import {
  ReportModel,
  type ReportTargetKind,
} from '../models/report.model.js';
import { PostModel } from '../models/post.model.js';

export type CreateReportDto = {
  reason: string;
};

export type ReportResponse = {
  id: string;
  targetKind: ReportTargetKind;
  targetId: string;
  reason: string;
  createdAt: string;
};

/**
 * Report a post. Idempotent — duplicate reports by the same user
 * are silently ignored and the existing report is returned.
 */
export async function reportPost(
  reporterUserId: string,
  postId: string,
  body: CreateReportDto,
): Promise<ReportResponse> {
  if (!mongoose.isValidObjectId(postId)) {
    throw new HttpError(400, 'Invalid post id', 'INVALID_POST_ID');
  }

  const post = await PostModel.findById(postId).lean();
  if (!post) {
    throw new HttpError(404, 'Post not found', 'POST_NOT_FOUND');
  }

  // Prevent self-report
  if (post.author.toString() === reporterUserId) {
    throw new HttpError(400, 'Cannot report your own post', 'SELF_REPORT');
  }

  const reporterId = new mongoose.Types.ObjectId(reporterUserId);
  const targetOid = new mongoose.Types.ObjectId(postId);

  // Upsert so duplicate reports are idempotent
  const report = await ReportModel.findOneAndUpdate(
    { reporter: reporterId, targetKind: 'post', targetId: targetOid },
    {
      $setOnInsert: {
        reporter: reporterId,
        targetKind: 'post' as const,
        targetId: targetOid,
        reason: body.reason,
      },
    },
    { upsert: true, new: true, lean: true },
  );

  if (!report) {
    throw new HttpError(500, 'Failed to create report', 'REPORT_CREATE_FAILED');
  }

  return {
    id: report._id.toString(),
    targetKind: report.targetKind,
    targetId: report.targetId.toString(),
    reason: report.reason,
    createdAt: report.createdAt.toISOString(),
  };
}
