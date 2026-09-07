'use client';

import { useRef, useState } from 'react';
import { Camera, CalendarPlus, Clock, Check, AlertTriangle, ShoppingCart, Sparkles, Utensils } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

type Recipe = {
  title: string;
  have: string[];
  need: string[];
  steps: string;
  minutes: number | null;
  allergenConflict: string | null;
};

const MAX_BYTES = 5 * 1024 * 1024;

function readAsBase64(file: File): Promise<{ data: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve({ data: result.slice(result.indexOf(',') + 1), mediaType: file.type });
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

export function FridgeChef() {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [addingIndex, setAddingIndex] = useState<number | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [planningIndex, setPlanningIndex] = useState<number | null>(null);
  const [planned, setPlanned] = useState<Set<number>>(new Set());
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);

  async function onFile(file: File | null) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { toastError('Please choose a photo (JPG/PNG/WebP).'); return; }
    if (file.size > MAX_BYTES) { toastError('Photo is too large (5 MB max).'); return; }
    setRecipes(null);
    setAdded(new Set());
    setPlanned(new Set());
    setPreview(URL.createObjectURL(file));
    setScanning(true);
    try {
      const { data, mediaType } = await readAsBase64(file);
      const res = await fetch('/api/ai/pantry-chef', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, mediaType }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Could not read that photo.'); return; }
      const found: Recipe[] = json.recipes ?? [];
      setRecipes(found);
      if (found.length === 0) toastError('No food spotted — try a clearer, well-lit photo.');
    } catch {
      toastError('Something went wrong reading the photo.');
    } finally {
      setScanning(false);
    }
  }

  async function addToGrocery(recipe: Recipe, index: number) {
    if (recipe.need.length === 0 || addingIndex !== null) return;
    setAddingIndex(index);
    try {
      const res = await fetch('/api/ai/pantry-chef', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addToGrocery: recipe.need }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Could not update your grocery list.'); return; }
      setAdded((prev) => new Set(prev).add(index));
      success(`Added ${json.added ?? recipe.need.length} item${(json.added ?? 0) === 1 ? '' : 's'} to your grocery list.`);
    } catch {
      toastError('Could not update your grocery list.');
    } finally {
      setAddingIndex(null);
    }
  }

  async function planForDinner(recipe: Recipe, index: number) {
    if (planningIndex !== null || planned.has(index)) return;
    setPlanningIndex(index);
    try {
      const res = await fetch('/api/ai/pantry-chef', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addToPlan: { title: recipe.title, steps: recipe.steps, have: recipe.have, need: recipe.need } }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Could not add that to your meal plan.'); return; }
      setPlanned((prev) => new Set(prev).add(index));
      success(`“${recipe.title}” planned for tonight's dinner.`);
    } catch {
      toastError('Could not add that to your meal plan.');
    } finally {
      setPlanningIndex(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-3xl border border-border bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-6 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand/15"><Utensils className="h-7 w-7 text-brand-text" /></div>
        <h2 className="mt-3 text-lg font-bold">{t('fridgeChef.whatCanIMakeForDinner')}</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          Snap a photo of your fridge or pantry. Bubaly spots what you have, suggests dinners that fit your family&apos;s allergies, and adds anything missing to your grocery list.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
        <Button className="mt-4 w-full sm:w-auto" onClick={() => fileRef.current?.click()} disabled={scanning}>
          <Camera className="h-4 w-4" /> {scanning ? 'Reading your photo…' : preview ? 'Try another photo' : 'Snap your fridge'}
        </Button>

        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={t('fridgeChef.yourFridge')} className="mx-auto mt-4 max-h-48 rounded-2xl border border-border object-cover" />
        )}
      </div>

      {scanning && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted">
          <Sparkles className="h-4 w-4 animate-pulse text-brand-text" /> {t('fridgeChef.cookingUpIdeasFromYourPhoto')}
        </div>
      )}

      {recipes && recipes.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {recipes.map((recipe, i) => (
            <div key={`${recipe.title}-${i}`} className="flex flex-col rounded-2xl border border-border bg-surface/40 p-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold leading-snug">{recipe.title}</h3>
                {recipe.minutes != null && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted"><Clock className="h-3.5 w-3.5" />{recipe.minutes}m</span>
                )}
              </div>

              {recipe.allergenConflict && (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-rose-500/15 px-2 py-1 text-xs font-medium text-rose-300">
                  <AlertTriangle className="h-3.5 w-3.5" /> May contain {recipe.allergenConflict}
                </p>
              )}

              {recipe.steps && <p className="mt-2 text-sm text-fg/90">{recipe.steps}</p>}

              {recipe.have.length > 0 && (
                <div className="mt-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-300/80">{t('fridgeChef.youHave')}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {recipe.have.map((h) => <span key={h} className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-200">{h}</span>)}
                  </div>
                </div>
              )}

              {recipe.need.length > 0 && (
                <div className="mt-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-300/80">{t('fridgeChef.needToBuy')}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {recipe.need.map((n) => <span key={n} className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-200">{n}</span>)}
                  </div>
                </div>
              )}

              <div className="mt-auto space-y-2 pt-4">
                <Button
                  className={cn('w-full', planned.has(i) && 'pointer-events-none opacity-70')}
                  onClick={() => planForDinner(recipe, i)}
                  disabled={planningIndex !== null}
                >
                  {planned.has(i)
                    ? <><Check className="h-4 w-4" /> On tonight&apos;s plan</>
                    : <><CalendarPlus className="h-4 w-4" />{' '}{t('fridgeChef.planForDinner')}</>}
                </Button>
                {recipe.need.length > 0 ? (
                  <Button
                    variant="secondary"
                    className={cn('w-full', added.has(i) && 'pointer-events-none opacity-70')}
                    onClick={() => addToGrocery(recipe, i)}
                    disabled={addingIndex !== null}
                  >
                    {added.has(i)
                      ? <><Check className="h-4 w-4" />{' '}{t('fridgeChef.addedToGrocery')}</>
                      : <><ShoppingCart className="h-4 w-4" /> Add {recipe.need.length} to grocery</>}
                  </Button>
                ) : (
                  <p className="text-center text-xs text-emerald-300">{t('fridgeChef.youHaveEverythingForThis')}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
