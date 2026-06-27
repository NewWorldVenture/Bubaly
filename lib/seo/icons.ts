// Maps the icon names an admin can type on a feature block to a curated set of
// lucide icons. Falls back to Sparkles so a typo never breaks a page.
import {
  Calendar, CheckSquare, Users, Bell, Heart, Home, ShoppingCart, Wallet,
  Shield, Sparkles, Clock, MapPin, MessageCircle, Camera, Star, Gift,
  Utensils, GraduationCap, Activity, BookOpen, type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  calendar: Calendar,
  checksquare: CheckSquare,
  tasks: CheckSquare,
  chores: CheckSquare,
  users: Users,
  family: Users,
  bell: Bell,
  reminders: Bell,
  heart: Heart,
  home: Home,
  cart: ShoppingCart,
  shopping: ShoppingCart,
  groceries: ShoppingCart,
  wallet: Wallet,
  money: Wallet,
  shield: Shield,
  security: Shield,
  sparkles: Sparkles,
  ai: Sparkles,
  clock: Clock,
  map: MapPin,
  location: MapPin,
  message: MessageCircle,
  chat: MessageCircle,
  camera: Camera,
  photos: Camera,
  star: Star,
  gift: Gift,
  meals: Utensils,
  food: Utensils,
  school: GraduationCap,
  health: Activity,
  recipes: BookOpen,
};

export function resolveIcon(name?: string): LucideIcon {
  if (!name) return Sparkles;
  return ICONS[name.toLowerCase().replace(/[^a-z]/g, '')] ?? Sparkles;
}
