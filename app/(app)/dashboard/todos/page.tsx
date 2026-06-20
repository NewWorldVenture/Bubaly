import type { Metadata } from 'next';
import { TodosModule } from '@/components/modules/todos-module';

export const metadata: Metadata = { title: 'To-Do Lists' };

export default function TodosPage() {
  return <TodosModule />;
}
