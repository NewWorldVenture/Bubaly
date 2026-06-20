'use client';

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

const CONVERSATIONS = [
  {
    prompt: "What's happening this week?",
    response: 'You have 6 events this week. Soccer practice on Tue & Thu, a math test Friday, and family dinner Sunday.',
  },
  {
    prompt: 'Plan dinners for the week',
    response: 'Honey garlic chicken, taco bowls, salmon & veggies, pasta primavera, and homemade pizza are ready to add.',
  },
  {
    prompt: 'What needs my attention?',
    response: 'Emma has a dentist visit at 8:00, two chores are due, and the grocery pickup window starts at 5:00.',
  },
];

export function AssistantConversation() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setActive((current) => (current + 1) % CONVERSATIONS.length);
    }, 5200);

    return () => window.clearInterval(interval);
  }, []);

  const conversation = CONVERSATIONS[active];

  return (
    <div className="relative z-10 flex h-full flex-col justify-end p-5 sm:p-7 lg:w-[48%] lg:justify-center lg:p-8">
      <div className="mb-3 inline-flex w-fit items-center gap-2 rounded-full border border-white/10 bg-[#101a28]/90 px-3 py-2 text-[11px] text-white/80 backdrop-blur-xl">
        <Sparkles className="h-3.5 w-3.5 text-violet-300" />
        FamilyOS AI
      </div>

      <div key={active} className="assistant-message-enter space-y-3" aria-live="polite">
        <div className="ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-md border border-white/10 bg-white/[0.10] px-4 py-3 text-xs font-medium leading-5 text-white shadow-xl backdrop-blur-xl sm:text-sm">
          {conversation.prompt}
        </div>
        <div className="flex items-end gap-2.5">
          <span className="glow-dot mb-1 h-7 w-7 shrink-0" />
          <div className="rounded-2xl rounded-bl-md border border-violet-300/15 bg-[#172231]/92 px-4 py-3 text-xs leading-5 text-white/86 shadow-xl backdrop-blur-xl sm:text-sm sm:leading-6">
            {conversation.response}
          </div>
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-1.5" aria-label="Assistant examples">
        {CONVERSATIONS.map((item, index) => (
          <button
            key={item.prompt}
            type="button"
            aria-label={`Show example ${index + 1}`}
            aria-pressed={active === index}
            onClick={() => setActive(index)}
            className={cn(
              'h-1.5 rounded-full transition-all duration-300 focus-ring',
              active === index ? 'w-7 bg-violet-400' : 'w-1.5 bg-white/25 hover:bg-white/50',
            )}
          />
        ))}
      </div>
    </div>
  );
}
