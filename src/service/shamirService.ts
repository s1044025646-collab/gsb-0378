import { randomUUID } from 'node:crypto';
import { Store } from '../db/database.js';
import {
  createShares,
  recoverSecret,
  validateShares,
  SCHEME_VERSION,
  type RecoverTrace,
  type Share,
} from '../core/shamir.js';
import { ShamirError } from '../core/errors.js';

export interface CreateSchemeInput {
  secret: number;
  threshold: number;
  count: number;
  demo?: boolean;
  demoCoefficients?: number[];
}

export interface SchemeView {
  schemeId: string;
  version: string;
  threshold: number;
  shareCount: number;
  demo: boolean;
  shares: Share[];
}

export class ShamirService {
  constructor(private store: Store) {}

  createScheme(input: CreateSchemeInput): SchemeView {
    const schemeId = randomUUID();
    const shares = createShares({
      schemeId,
      secret: BigInt(input.secret),
      threshold: input.threshold,
      count: input.count,
      demo: input.demo,
      demoCoefficients: input.demoCoefficients?.map(BigInt),
    });
    this.store.saveSchemeAndShares(
      {
        id: schemeId,
        version: SCHEME_VERSION,
        threshold: input.threshold,
        shareCount: input.count,
        demo: input.demo ? 1 : 0,
        createdAt: new Date().toISOString(),
      },
      shares
    );
    return {
      schemeId,
      version: SCHEME_VERSION,
      threshold: input.threshold,
      shareCount: input.count,
      demo: Boolean(input.demo),
      shares,
    };
  }

  getScheme(schemeId: string): SchemeView {
    const rec = this.store.getScheme(schemeId);
    if (!rec) throw new ShamirError('SCHEME_NOT_FOUND', `方案不存在：${schemeId}`);
    return {
      schemeId: rec.id,
      version: rec.version,
      threshold: rec.threshold,
      shareCount: rec.shareCount,
      demo: Boolean(rec.demo),
      shares: this.store.getShares(schemeId),
    };
  }

  /**
   * 用调用者提供的份额恢复。绝不从数据库查回原秘密充当插值输出。
   * 数据库仅用于校验方案公共参数与记录恢复操作状态。
   */
  recover(
    schemeId: string,
    provided: Share[],
    options: { persist?: boolean } = {}
  ): { recovered: number; trace: RecoverTrace } {
    const scheme = this.store.getScheme(schemeId);
    if (!scheme) throw new ShamirError('SCHEME_NOT_FOUND', `方案不存在：${schemeId}`);

    const stamped = provided.map((s) => ({ ...s, schemeId, version: SCHEME_VERSION }));

    try {
      validateShares(stamped, schemeId, scheme.threshold);
      const { recovered, trace } = recoverSecret(stamped);
      if (options.persist !== false) {
        this.store.recordRecovery({
          id: randomUUID(),
          schemeId,
          status: 'success',
          reasonCode: null,
          selectedX: JSON.stringify(trace.selectedX),
          createdAt: new Date().toISOString(),
        });
      }
      return { recovered: Number(recovered), trace };
    } catch (err) {
      if (err instanceof ShamirError && options.persist !== false) {
        this.store.recordRecovery({
          id: randomUUID(),
          schemeId,
          status: 'rejected',
          reasonCode: err.code,
          selectedX: null,
          createdAt: new Date().toISOString(),
        });
      }
      throw err;
    }
  }

  listRecoveries(schemeId: string) {
    if (!this.store.getScheme(schemeId)) {
      throw new ShamirError('SCHEME_NOT_FOUND', `方案不存在：${schemeId}`);
    }
    return this.store.listRecoveries(schemeId);
  }
}
