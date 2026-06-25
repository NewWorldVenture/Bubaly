'use client';

// Maps the registry's string icon keys to Lucide components (keeps the registry
// server-safe/serializable). Unknown keys fall back to a neutral dot.
import {
  Plus, Sparkles, Calendar, ShoppingCart, ListChecks, MessageCircle, StickyNote, Image as ImageIcon,
  Users, Repeat, NotebookPen, GraduationCap, UtensilsCrossed, CloudSun, Wallet, CreditCard,
  CheckSquare, ChefHat, FolderLock, Target, HeartPulse, Plane, CalendarRange, Gauge, Trophy,
  Gift, Sun, Command, Rocket, ShieldAlert, CircleDot, type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  plus: Plus, sparkles: Sparkles, calendar: Calendar, cart: ShoppingCart, list: ListChecks,
  message: MessageCircle, note: StickyNote, image: ImageIcon, users: Users, repeat: Repeat,
  notebook: NotebookPen, school: GraduationCap, meal: UtensilsCrossed, weather: CloudSun,
  wallet: Wallet, card: CreditCard, check: CheckSquare, chef: ChefHat, folder: FolderLock,
  target: Target, heart: HeartPulse, plane: Plane, 'calendar-range': CalendarRange, gauge: Gauge,
  trophy: Trophy, gift: Gift, sun: Sun, command: Command, rocket: Rocket, shield: ShieldAlert,
};

export function FeatureIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICONS[icon] ?? CircleDot;
  return <Icon className={className} />;
}
