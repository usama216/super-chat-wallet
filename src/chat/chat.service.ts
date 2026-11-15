import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { StreamsService } from '../super-chats/streams.service';

export interface ChatMessage {
  id: number;
  streamId: string;
  senderId: string;
  text: string;
  createdAt: Date;
}

const COLUMNS = `id, stream_id AS "streamId", sender_id AS "senderId", text, created_at AS "createdAt"`;

@Injectable()
export class ChatService {
  constructor(
    private readonly db: DatabaseService,
    private readonly streams: StreamsService,
  ) {}

  async post(streamId: string, senderId: string, text: string): Promise<ChatMessage> {
    await this.streams.get(streamId); // 404 if the live doesn't exist
    const { rows } = await this.db.query<ChatMessage>(
      `INSERT INTO chat_messages (stream_id, sender_id, text) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [streamId, senderId, text],
    );
    return rows[0];
  }

  /** The latest messages of a live, oldest first. */
  async latest(streamId: string, limit: number): Promise<ChatMessage[]> {
    const { rows } = await this.db.query<ChatMessage>(
      `SELECT * FROM (
         SELECT ${COLUMNS} FROM chat_messages WHERE stream_id = $1 ORDER BY id DESC LIMIT $2
       ) latest ORDER BY id`,
      [streamId, limit],
    );
    return rows;
  }
}
