/// <reference types="node" />
/** Typed Model Tides HTTP client shared by the CLI and library consumers. */
import { brotliCompressSync } from 'node:zlib';
import { parseOwnedReport, type OwnedReport, type WeeklySnapshot } from './weekly-snapshot.ts';

/** The contributions endpoint every request is made against. */
export const API = 'https://modeltides.dev/api/contributions';

/** An owner's private credential: report id plus its bearer token. */
export interface Owner {
    id: string;
    token: string;
}

/** The stored report state reviewed before a sharing or aggregate change. */
export interface ReviewedReport {
    snapshot: WeeklySnapshot | null;
    revision: number;
}

/** The validated upload response used to update a personal report. */
export interface UploadResult {
    id: string;
    token?: string;
    published: boolean;
    inAggregate: boolean;
    metricVersion: number;
    url?: string;
}

type FetchImpl = typeof fetch;

export function uploadOSForPlatform(platform: NodeJS.Platform): 'macos' | 'windows' | 'linux' | 'other' {
    switch (platform) {
        case 'darwin': return 'macos';
        case 'win32': return 'windows';
        case 'linux': return 'linux';
        default: return 'other';
    }
}

export async function publishSnapshot(
    snapshot: WeeklySnapshot,
    owner: Owner | null = null,
    fetchImpl: FetchImpl = fetch,
    endpoint: string = API,
    published: boolean | null = null,
    inAggregate: boolean | null = null,
    reviewedRevision: number | null = null,
    os: 'linux' | 'macos' | 'windows' | 'other' | null = uploadOSForPlatform(process.platform),
): Promise<Record<string, unknown>> {
    if (owner && (typeof published !== 'boolean' || typeof inAggregate !== 'boolean')) throw new TypeError('Expected report state.');
    const migrating = !!owner && snapshot.version === 2 && reviewedRevision !== null;
    if (migrating && (!Number.isSafeInteger(reviewedRevision) || reviewedRevision < 0)) throw new TypeError('Expected reviewed revision.');
    if (os !== null && !['linux', 'macos', 'windows', 'other'].includes(os)) throw new TypeError('Invalid upload OS.');
    const body = brotliCompressSync(Buffer.from(JSON.stringify(snapshot)));
    const response = await fetchImpl(owner ? `${endpoint}/${owner.id}${migrating ? '/migrate-v2' : ''}` :
        `${endpoint}/${snapshot.version === 2 ? 'personal-v2' : 'personal'}`, {
        method: owner ? 'PUT' : 'POST',
        headers: {
            'Content-Type': 'application/vnd.model-tides.weekly+json',
            'Content-Encoding': 'br',
            'X-Model-Tides-Schema': `weekly-v${snapshot.version}`,
            ...(os === null ? {} : { 'X-Model-Tides-Upload-OS': os }),
            ...(!owner ? { 'X-Model-Tides-Report': `personal-v${snapshot.version}` } : {}),
            ...(owner ? { Authorization: `Bearer ${owner.token}`,
                'X-Model-Tides-Expected-Visibility': published ? 'public' : 'private',
                'X-Model-Tides-Expected-Aggregate': inAggregate ? 'included' : 'excluded',
                ...(migrating ? { 'X-Model-Tides-Reviewed-Revision': String(reviewedRevision) } : {}) } : {}),
        },
        body,
    });
    if (!response.ok) throw new Error(`Upload failed (HTTP ${response.status}). No successful upload was confirmed; your local history is unchanged.`);
    return await response.json() as Record<string, unknown>;
}

export async function getOwnedReport(owner: Owner, fetchImpl: FetchImpl = fetch, endpoint: string = API): Promise<OwnedReport> {
    try {
        const response = await fetchImpl(`${endpoint}/${owner.id}`, {
            headers: { Authorization: `Bearer ${owner.token}` }, cache: 'no-store',
        } as RequestInit);
        if (!response.ok) throw new TypeError('Unavailable report.');
        return parseOwnedReport(await response.json(), owner.id);
    } catch {
        throw new Error('Could not confirm personal report visibility and counts. No sharing change was started.');
    }
}

export async function setSharing(owner: Owner, published: boolean, fetchImpl: FetchImpl = fetch, endpoint: string = API,
    reviewed: ReviewedReport | null = null): Promise<{ id: string; published: boolean; url?: string }> {
    if (published && (!reviewed || !reviewed.snapshot || !Number.isSafeInteger(reviewed.revision) || reviewed.revision < 0)) {
        throw new Error('Review every stored weekly count before sharing.');
    }
    const revision = reviewed?.revision;
    const response = await fetchImpl(`${endpoint}/${owner.id}/${published ? 'share' : 'unshare'}`, {
        method: 'POST', headers: { Authorization: `Bearer ${owner.token}`,
            ...(published ? { 'X-Model-Tides-Reviewed-Revision': String(revision) } : {}) },
    }).catch(() => null);
    if (response && !response.ok) throw new Error('Sharing was rejected. Review the current report before retrying.');
    try {
        if (!response) throw new TypeError('Sharing response unavailable.');
        const result = await response.json() as { id: string; published: boolean; url?: string };
        if (result.id !== owner.id || result.published !== published ||
            (published && result.url !== `${new URL(endpoint).origin}/u/${owner.id}`)) {
            throw new TypeError('Invalid sharing response.');
        }
        return result;
    } catch {
        const current = await getOwnedReport(owner, fetchImpl, endpoint).catch(() => null);
        if (!current) throw new Error('Could not confirm personal report visibility. The change may have happened; check before retrying.');
        if (current.published !== published || (published &&
            (current.revision !== revision! + 1 || JSON.stringify(current.snapshot) !== JSON.stringify(reviewed!.snapshot)))) {
            throw new Error(`The personal report is ${current.published ? 'public' : 'hidden'}. The sharing change was not confirmed; review again before retrying.`);
        }
        return { id: owner.id, published, ...(published ? { url: `${new URL(endpoint).origin}/u/${owner.id}` } : {}) };
    }
}

export async function reportVisibility(owner: Owner, fetchImpl: FetchImpl = fetch, endpoint: string = API): Promise<OwnedReport> {
    try {
        const report = await getOwnedReport(owner, fetchImpl, endpoint);
        if (report.inAggregate === null) throw new TypeError('Unknown aggregate participation.');
        return report;
    } catch {
        throw new Error('Could not confirm personal report visibility and aggregate participation. No upload was started.');
    }
}

export async function setAggregate(owner: Owner, contribute: boolean, fetchImpl: FetchImpl = fetch, endpoint: string = API,
    reviewed: ReviewedReport | null = null): Promise<{ id: string; inAggregate: boolean }> {
    if (contribute && (!reviewed?.snapshot || !Number.isSafeInteger(reviewed.revision) || reviewed.revision < 0)) {
        throw new Error('Review every stored weekly count before contributing.');
    }
    const response = await fetchImpl(`${endpoint}/${owner.id}/${contribute ? 'contribute' : 'withdraw'}`, {
        method: 'POST', headers: { Authorization: `Bearer ${owner.token}`,
            ...(contribute ? { 'X-Model-Tides-Reviewed-Revision': String(reviewed!.revision) } : {}) },
    }).catch(() => null);
    if (response && !response.ok) throw new Error('Aggregate change was rejected. Review your current report before retrying.');
    try {
        if (!response) throw new TypeError('Aggregate response unavailable.');
        const result = await response.json() as { id: string; inAggregate: boolean };
        if (result.id !== owner.id || result.inAggregate !== contribute) throw new TypeError('Invalid aggregate response.');
        return result;
    } catch {
        const current = await getOwnedReport(owner, fetchImpl, endpoint).catch(() => null);
        if (!current || current.inAggregate !== contribute || (contribute &&
            (current.revision !== reviewed!.revision + 1 || JSON.stringify(current.snapshot) !== JSON.stringify(reviewed!.snapshot)))) {
            throw new Error('Could not confirm the aggregate change. Check your report before retrying.');
        }
        return { id: owner.id, inAggregate: contribute };
    }
}

/** `DELETE ${endpoint}/${owner.id}` — remove the stored report and its counts. */
export async function deleteReport(owner: Owner, fetchImpl: FetchImpl = fetch, endpoint: string = API): Promise<void> {
    const response = await fetchImpl(`${endpoint}/${owner.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${owner.token}` },
    });
    if (!response.ok) throw new Error(`Request failed (HTTP ${response.status}).`);
}

/** `POST ${endpoint}/${owner.id}/rotate` — return the replacement owner key. */
export async function rotateReport(owner: Owner, fetchImpl: FetchImpl = fetch, endpoint: string = API): Promise<Owner> {
    const response = await fetchImpl(`${endpoint}/${owner.id}/rotate`, {
        method: 'POST', headers: { Authorization: `Bearer ${owner.token}` },
    });
    if (!response.ok) throw new Error(`Request failed (HTTP ${response.status}).`);
    const { token } = await response.json() as { token: unknown };
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid rotate response.');
    return { id: owner.id, token };
}

/**
 * Validate a `publishSnapshot` response against the reviewed report state.
 * On a state mismatch a fresh contribution is rolled back exactly like the
 * CLI. When `owner` is null, `saveOwner` must persist the new credential
 * exactly once — throwing there triggers the same rollback DELETE.
 */
export async function confirmCreatedReport(
    result: unknown,
    snapshot: WeeklySnapshot,
    owner: Owner | null,
    published: boolean | null,
    inAggregate: boolean | null,
    saveOwner: (owner: Owner) => void = () => {},
    fetchImpl: FetchImpl = fetch,
    endpoint: string = API,
): Promise<UploadResult> {
    const upload = result as UploadResult;
    if (!result || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(upload.id)) ||
        upload.id !== (owner?.id ?? upload.id) || typeof upload.published !== 'boolean' ||
        typeof upload.inAggregate !== 'boolean' || upload.metricVersion !== snapshot.version ||
        (!owner && (typeof upload.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(upload.token)))) {
        throw new Error('Invalid upload response.');
    }
    if ((!owner && (upload.published !== true || upload.inAggregate !== false ||
        upload.url !== `${new URL(endpoint).origin}/u/${upload.id}`)) ||
        (owner && (upload.published !== published || upload.inAggregate !== inAggregate))) {
        if (!owner) await fetchImpl(`${endpoint}/${upload.id}`, { method: 'DELETE', headers: {
            Authorization: `Bearer ${upload.token}` },
        }).catch(() => {});
        throw new Error('Upload response did not match the reviewed report state. Check your report before retrying.');
    }
    if (!owner) {
        try { saveOwner({ id: upload.id, token: upload.token! }); }
        catch {
            const removed = await fetchImpl(`${endpoint}/${upload.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${upload.token}` } })
                .then((response) => response.ok, () => false);
            throw new Error(removed ? 'Could not save your private key; the new contribution was removed.' :
                'Could not save your private key or remove the new contribution.');
        }
    }
    return upload;
}
