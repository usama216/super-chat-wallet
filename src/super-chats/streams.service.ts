import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface Stream {
  id: string;
  creatorId: string;
  createdAt: Date;
}

@Injectable()
export class StreamsService {
  constructor(private readonly db: DatabaseService) {}

  async create(creatorId: string, streamId: string): Promise<Stream> {
    const { rows } = await this.db.query<Stream>(
      `INSERT INTO streams (id, creator_id) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, creator_id AS "creatorId", created_at AS "createdAt"`,
      [streamId, creatorId],
    );
    if (rows.length === 0) {
      throw new ConflictException(`Stream ${streamId} already exists`);
    }
    return rows[0];
  }

  /** Seq of the latest super chat on the stream, 0 if none. */
  async lastSeq(streamId: string): Promise<number> {
    const { rows } = await this.db.query<{ lastSeq: number }>(
      'SELECT last_seq AS "lastSeq" FROM streams WHERE id = $1',
      [streamId],
    );
    if (rows.length === 0) throw new NotFoundException(`Stream ${streamId} not found`);
    return rows[0].lastSeq;
  }

  async get(streamId: string): Promise<Stream> {
    const { rows } = await this.db.query<Stream>(
      `SELECT id, creator_id AS "creatorId", created_at AS "createdAt" FROM streams WHERE id = $1`,
      [streamId],
    );
    if (rows.length === 0) throw new NotFoundException(`Stream ${streamId} not found`);
    return rows[0];
  }
}
