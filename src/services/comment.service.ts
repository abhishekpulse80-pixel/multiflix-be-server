import mongoose, { type Types } from 'mongoose';
import { HttpError } from '../lib/httpError.js';
import { CommentModel } from '../models/comment.model.js';
import { PostModel } from '../models/post.model.js';
import { UserModel } from '../models/user.model.js';
import type {
  CommentListQuery,
  CreateCommentBody,
} from '../schemas/comments.schemas.js';
import { createNotification, sendToUser } from './notification.service.js';
import { listHiddenUserIds } from './userBlock.service.js';

export type CommentDto = {
  id: string;
  postId: string;
  authorId: string;
  authorDisplayName: string;
  authorAvatarUrl: string | null;
  text: string;
  createdAt: string;
  updatedAt: string;
};

export type CommentListResponse = {
  comments: CommentDto[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
};

function assertObjectId(id: string, code: string): void {
  if (!mongoose.isValidObjectId(id)) {
    throw new HttpError(400, 'Invalid id', code);
  }
}

type AuthorLean = {
  _id: Types.ObjectId;
  fullName?: string | null;
  avatarUrl?: string | null;
};

/** Lean comment from DB (author is ObjectId, not populated). */
type CommentDocLean = {
  _id: Types.ObjectId;
  post: Types.ObjectId;
  author: Types.ObjectId;
  text: string;
  createdAt: Date;
  updatedAt: Date;
};

function asDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function displayNameFromAuthor(author: AuthorLean): string {
  const full = author.fullName?.trim();
  if (full) {
    return full;
  }
  return `User ${author._id.toString().slice(-6)}`;
}

async function loadUsersByIds(authorIds: string[]): Promise<Map<string, AuthorLean>> {
  const uniq = [...new Set(authorIds)].filter(id => mongoose.isValidObjectId(id));
  if (uniq.length === 0) {
    return new Map();
  }
  const users = await UserModel.find({ _id: { $in: uniq } })
    .select('fullName avatarUrl')
    .lean();
  const map = new Map<string, AuthorLean>();
  for (const u of users) {
    map.set(String(u._id), u as AuthorLean);
  }
  return map;
}

function commentToDto(doc: CommentDocLean, userByAuthorId: Map<string, AuthorLean>): CommentDto {
  const id = doc._id.toString();
  const postId = doc.post.toString();
  const authorKey = doc.author.toString();
  const user = userByAuthorId.get(authorKey);

  const createdAt = asDate(doc.createdAt);
  const updatedAt = asDate(doc.updatedAt);

  let authorDisplayName: string;
  let authorAvatarUrl: string | null;
  if (user) {
    authorDisplayName = displayNameFromAuthor(user);
    authorAvatarUrl =
      typeof user.avatarUrl === 'string' && user.avatarUrl.trim().length > 0
        ? user.avatarUrl.trim()
        : null;
  } else {
    authorDisplayName = `User ${authorKey.slice(-6)}`;
    authorAvatarUrl = null;
  }

  return {
    id,
    postId,
    authorId: authorKey,
    authorDisplayName,
    authorAvatarUrl,
    text: doc.text,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

export async function listComments(
  postId: string,
  query: CommentListQuery,
  viewerId?: string,
): Promise<CommentListResponse> {
  assertObjectId(postId, 'INVALID_POST_ID');
  const postExists = await PostModel.exists({ _id: postId });
  if (!postExists) {
    throw new HttpError(404, 'Post not found', 'POST_NOT_FOUND');
  }

  const { page, limit } = query;
  const skip = page * limit;
  const filter: Record<string, unknown> = { post: postId };

  if (viewerId && mongoose.isValidObjectId(viewerId)) {
    const hiddenIds = await listHiddenUserIds(viewerId);
    if (hiddenIds.length > 0) {
      filter.author = {
        $nin: hiddenIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  const [total, docs] = await Promise.all([
    CommentModel.countDocuments(filter),
    CommentModel.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const typed = docs as CommentDocLean[];
  const authorIds = typed.map(d => d.author.toString());
  const userByAuthorId = await loadUsersByIds(authorIds);
  const comments = typed.map(d => commentToDto(d, userByAuthorId));

  return {
    comments,
    page,
    limit,
    total,
    hasMore: skip + comments.length < total,
  };
}

export async function createComment(
  userId: string,
  postId: string,
  body: CreateCommentBody,
): Promise<CommentDto> {
  assertObjectId(postId, 'INVALID_POST_ID');
  if (!mongoose.isValidObjectId(userId)) {
    throw new HttpError(400, 'Invalid user id', 'INVALID_USER_ID');
  }

  const postExists = await PostModel.exists({ _id: postId });
  if (!postExists) {
    throw new HttpError(404, 'Post not found', 'POST_NOT_FOUND');
  }

  const doc = await CommentModel.create({
    post: postId,
    author: userId,
    text: body.text,
  });

  await PostModel.updateOne({ _id: postId }, { $inc: { commentsCount: 1 } });

  const saved = await CommentModel.findById(doc._id).lean();
  if (!saved) {
    throw new HttpError(500, 'Comment could not be loaded', 'COMMENT_LOAD_FAILED');
  }

  const lean = saved as CommentDocLean;
  const userByAuthorId = await loadUsersByIds([lean.author.toString()]);
  const dto = commentToDto(lean, userByAuthorId);

  // Fire-and-forget push to the post author. Skip self-comments.
  void (async () => {
    try {
      const post = await PostModel.findById(postId)
        .select('author')
        .lean<{ author: Types.ObjectId }>();
      const authorId = post?.author?.toString();
      if (!authorId || authorId === userId) return;
      const commenter = await UserModel.findById(userId)
        .select('fullName username')
        .lean<{
          fullName: string | null;
          username: string;
        }>();
      const name =
        commenter?.fullName?.trim() ||
        commenter?.username ||
        'Someone';
      const preview =
        body.text.length > 120 ? `${body.text.slice(0, 117)}…` : body.text;
      await createNotification({
        recipient: authorId,
        actor: userId,
        type: 'post_comment',
        post: postId,
        comment: dto.id,
      });
      await sendToUser(authorId, {
        type: 'post_comment',
        title: 'New comment',
        body: `${name}: ${preview}`,
        data: { postId, commentId: dto.id, commenterId: userId },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.warn('[comment] push dispatch failed:', msg);
    }
  })();

  return dto;
}
