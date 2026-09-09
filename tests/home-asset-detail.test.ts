import { describe, expect, it } from 'vitest';
import {
  composeAssetDetail,
  coverageState,
  sameRoom,
  LIVE_PROJECT_STATUSES,
  MANUAL_CATEGORY,
  WARRANTY_CATEGORY,
  type AssetDetailInput,
  type AssetDocumentRow,
  type AssetProjectRow,
  type AssetRow,
  type AssetServiceRow,
  type AssetTaskRow,
  type AssetWarrantyRow,
} from '@/lib/home/asset-detail';

const TODAY = '2026-06-01';

function asset(over: Partial<AssetRow> = {}): AssetRow {
  return {
    id: 'asset-1',
    family_id: 'fam-1',
    name: 'Refrigerator',
    category: 'refrigerator',
    location: 'Kitchen',
    brand: 'Bosch',
    model: 'B36CT80SNS',
    purchased_on: '2020-04-02',
    warranty_until: null,
    notes: null,
    home_id: null,
    serial_number: 'SN-1',
    installed_on: '2020-04-10',
    filter_size: null,
    purchase_price: null,
    expected_life_years: null,
    condition: 'good',
    last_serviced_on: '2026-01-10',
    created_by: null,
    created_at: '2020-04-10T00:00:00Z',
    updated_at: '2026-01-10T00:00:00Z',
    ...over,
  } as AssetRow;
}

function warranty(over: Partial<AssetWarrantyRow> = {}): AssetWarrantyRow {
  return {
    id: 'war-1',
    family_id: 'fam-1',
    home_id: null,
    asset_id: 'asset-1',
    name: 'Bosch extended warranty',
    provider: 'Bosch',
    warranty_type: 'extended',
    policy_number: null,
    coverage: null,
    starts_on: '2020-04-10',
    expires_on: '2027-04-10',
    cost: null,
    premium_period: null,
    claim_phone: '+1 555 0100',
    claim_url: null,
    claim_email: null,
    document_id: null,
    status: 'active',
    notes: null,
    created_by: null,
    updated_by: null,
    deleted_at: null,
    metadata: {},
    created_at: '2020-04-10T00:00:00Z',
    updated_at: '2020-04-10T00:00:00Z',
    ...over,
  } as AssetWarrantyRow;
}

function doc(over: Partial<AssetDocumentRow> = {}): AssetDocumentRow {
  return {
    id: 'doc-1',
    family_id: 'fam-1',
    title: 'fridge-manual.pdf',
    category: MANUAL_CATEGORY,
    storage_path: 'fam-1/manuals/asset-1/fridge-manual.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1024,
    expires_at: null,
    member_id: null,
    asset_id: 'asset-1',
    is_favorite: false,
    is_secure: false,
    created_by: null,
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    ...over,
  } as AssetDocumentRow;
}

function service(over: Partial<AssetServiceRow> = {}): AssetServiceRow {
  return {
    id: 'svc-1',
    family_id: 'fam-1',
    home_id: null,
    asset_id: 'asset-1',
    contractor_id: null,
    title: 'Coil clean',
    service_date: '2026-01-10',
    provider: 'Ace Appliance',
    cost: 120,
    description: null,
    next_due_on: '2026-07-10',
    created_by: null,
    updated_by: null,
    deleted_at: null,
    metadata: {},
    created_at: '2026-01-10T00:00:00Z',
    updated_at: '2026-01-10T00:00:00Z',
    ...over,
  } as AssetServiceRow;
}

function task(over: Partial<AssetTaskRow> = {}): AssetTaskRow {
  return {
    id: 'task-1',
    family_id: 'fam-1',
    asset_id: 'asset-1',
    title: 'Replace water filter',
    description: null,
    status: 'todo',
    priority: 'medium',
    recurrence: 'none',
    interval_days: 180,
    due_at: '2026-06-20T09:00:00Z',
    completed_at: null,
    assignee_id: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  } as AssetTaskRow;
}

function project(over: Partial<AssetProjectRow> = {}): AssetProjectRow {
  return {
    id: 'proj-1',
    family_id: 'fam-1',
    title: 'Kitchen backsplash',
    description: null,
    room: 'Kitchen',
    kind: 'renovation',
    status: 'in_progress',
    priority: 'medium',
    is_diy: true,
    budget_cents: 90000,
    labor_cents: 0,
    target_start: '2026-06-10',
    target_end: null,
    completed_at: null,
    owner_id: null,
    contractor_id: null,
    photo_path: null,
    notes: null,
    created_by: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-20T00:00:00Z',
    ...over,
  } as AssetProjectRow;
}

function input(over: Partial<AssetDetailInput> = {}): AssetDetailInput {
  return {
    asset: asset(),
    warranties: [],
    documents: [],
    serviceRecords: [],
    openTasks: [],
    projects: [],
    today: TODAY,
    ...over,
  };
}

describe('coverageState', () => {
  it('calls a missing end date unknown, never covered', () => {
    // The reassuring-empty-state failure in date form: a family that never
    // recorded an expiry has an open question, not an active warranty.
    expect(coverageState(null, TODAY)).toBe('unknown');
    expect(coverageState(undefined, TODAY)).toBe('unknown');
  });

  it('separates expired, ending soon and active around the 45-day window', () => {
    expect(coverageState('2026-05-31', TODAY)).toBe('expired');
    expect(coverageState('2026-06-01', TODAY)).toBe('expiring'); // today counts as ending
    expect(coverageState('2026-07-16', TODAY)).toBe('expiring'); // 45 days out
    expect(coverageState('2026-07-17', TODAY)).toBe('active');   // 46 days out
  });
});

describe('sameRoom', () => {
  it('matches case- and whitespace-insensitively, and never matches on blank', () => {
    expect(sameRoom('Kitchen', ' kitchen ')).toBe(true);
    expect(sameRoom('Kitchen', 'Garage')).toBe(false);
    // A blank location must not silently match every project with a blank room:
    // that would attach the whole family's unroomed work to one asset.
    expect(sameRoom('', '')).toBe(false);
    expect(sameRoom(null, 'Kitchen')).toBe(false);
    expect(sameRoom('Kitchen', null)).toBe(false);
  });
});

describe('composeAssetDetail', () => {
  it('splits documents into manuals, warranty files and everything else', () => {
    const detail = composeAssetDetail(input({
      documents: [
        doc({ id: 'd-manual', category: MANUAL_CATEGORY, title: 'manual.pdf' }),
        doc({ id: 'd-warranty', category: WARRANTY_CATEGORY, title: 'warranty.pdf' }),
        doc({ id: 'd-receipt', category: 'receipt', title: 'receipt.pdf' }),
        doc({ id: 'd-untyped', category: null, title: 'photo.jpg' }),
      ],
    }));

    expect(detail.manuals.map((d) => d.id)).toEqual(['d-manual']);
    expect(detail.warrantyDocuments.map((d) => d.id)).toEqual(['d-warranty']);
    expect(detail.otherDocuments.map((d) => d.id)).toEqual(['d-receipt', 'd-untyped']);
  });

  it('treats a differently-cased category as the same kind', () => {
    const detail = composeAssetDetail(input({
      documents: [doc({ id: 'd-1', category: ' Manual ' })],
    }));
    expect(detail.manuals.map((d) => d.id)).toEqual(['d-1']);
  });

  it('prefers a warranty row over the asset date, soonest expiry first', () => {
    const detail = composeAssetDetail(input({
      asset: asset({ warranty_until: '2026-12-31' }),
      warranties: [
        warranty({ id: 'later', expires_on: '2028-01-01' }),
        warranty({ id: 'sooner', expires_on: '2026-06-20' }),
      ],
    }));

    expect(detail.coverages.map((c) => c.id)).toEqual(['sooner', 'later']);
    expect(detail.coverage?.id).toBe('sooner');
    expect(detail.coverage?.source).toBe('home_warranties');
    expect(detail.coverage?.state).toBe('expiring');
    expect(detail.coverage?.daysLeft).toBe(19);
  });

  it('falls back to the asset warranty date and labels where it came from', () => {
    const detail = composeAssetDetail(input({ asset: asset({ warranty_until: '2029-01-01' }) }));
    expect(detail.coverage?.source).toBe('home_assets');
    expect(detail.coverage?.state).toBe('active');
    expect(detail.coverages).toEqual([]);
  });

  it('reports no coverage at all when neither a warranty row nor a date exists', () => {
    expect(composeAssetDetail(input()).coverage).toBeNull();
  });

  it('drops soft-deleted warranties and service records', () => {
    const detail = composeAssetDetail(input({
      warranties: [warranty({ id: 'gone', deleted_at: '2026-05-01T00:00:00Z' })],
      serviceRecords: [service({ id: 'gone', deleted_at: '2026-05-01T00:00:00Z' })],
    }));
    expect(detail.coverages).toEqual([]);
    expect(detail.serviceHistory).toEqual([]);
  });

  it('orders service history newest first', () => {
    const detail = composeAssetDetail(input({
      serviceRecords: [
        service({ id: 'old', service_date: '2024-03-01' }),
        service({ id: 'newest', service_date: '2026-01-10' }),
        service({ id: 'middle', service_date: '2025-05-05' }),
      ],
    }));
    expect(detail.serviceHistory.map((r) => r.id)).toEqual(['newest', 'middle', 'old']);
  });

  it('keeps only open maintenance, soonest due first, undated last', () => {
    const detail = composeAssetDetail(input({
      openTasks: [
        task({ id: 'undated', due_at: null, title: 'Zebra' }),
        task({ id: 'later', due_at: '2026-08-01T00:00:00Z' }),
        task({ id: 'done', status: 'done' }),
        task({ id: 'soon', due_at: '2026-06-05T00:00:00Z' }),
        task({ id: 'in-progress', status: 'in_progress', due_at: '2026-06-06T00:00:00Z' }),
      ],
    }));
    expect(detail.openMaintenance.map((t) => t.id)).toEqual(['soon', 'in-progress', 'later', 'undated']);
  });

  it('relates live projects by room and names the room it matched on', () => {
    const detail = composeAssetDetail(input({
      projects: [
        project({ id: 'same-room', room: 'kitchen' }),
        project({ id: 'other-room', room: 'Garage' }),
        project({ id: 'no-room', room: null }),
      ],
    }));
    expect(detail.relatedProjects.map((p) => p.id)).toEqual(['same-room']);
    expect(detail.roomLabel).toBe('Kitchen');
  });

  it('never claims a project relation for an asset with no location', () => {
    // home_projects has no asset_id, so a room match is all there is. With no
    // room, there is nothing to match on and the panel must stay empty rather
    // than attaching the family's whole project list to this asset.
    const detail = composeAssetDetail(input({
      asset: asset({ location: '   ' }),
      projects: [project({ id: 'p1', room: 'Kitchen' }), project({ id: 'p2', room: '' })],
    }));
    expect(detail.relatedProjects).toEqual([]);
    expect(detail.roomLabel).toBeNull();
  });

  it('excludes finished and cancelled projects from the room panel', () => {
    const detail = composeAssetDetail(input({
      projects: [
        project({ id: 'done', status: 'done' }),
        project({ id: 'cancelled', status: 'cancelled' }),
        project({ id: 'planning', status: 'planning' }),
      ],
    }));
    expect(detail.relatedProjects.map((p) => p.id)).toEqual(['planning']);
    expect(LIVE_PROJECT_STATUSES).not.toContain('done');
    expect(LIVE_PROJECT_STATUSES).not.toContain('cancelled');
  });
});
