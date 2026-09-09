import { getTranslations } from '@/lib/i18n/server';
export async function AssistantConversation() {
  const t = await getTranslations();
  return (
    <div className="relative z-10 flex h-full flex-col justify-center p-4 sm:p-6 lg:w-[50%] lg:p-7">
      <div className="assistant-message-enter space-y-3">
        <div className="ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-md border border-white/10 bg-white/[0.10] px-4 py-3 text-xs font-medium leading-5 text-white shadow-xl backdrop-blur-xl sm:text-sm">
          {t('homepageInteractions.whatsHappeningThisWeek')}
        </div>
        <div className="flex items-end gap-2.5">
          <span className="glow-dot mb-1 h-7 w-7 shrink-0" />
          <div className="rounded-2xl rounded-bl-md border border-violet-300/15 bg-[#172231]/92 px-4 py-3 text-xs leading-5 text-white/86 shadow-xl backdrop-blur-xl sm:text-sm sm:leading-6">
            {t('homepageInteractions.youHave6EventsThisWeek')}
          </div>
        </div>
        <div className="ml-auto mt-2 w-fit max-w-[90%] rounded-2xl rounded-br-md border border-white/10 bg-white/[0.10] px-4 py-3 text-xs font-medium leading-5 text-white shadow-xl backdrop-blur-xl sm:text-sm">{t('homepageInteractions.planDinnersForTheWeek')}</div>
        <div className="flex items-end gap-2.5">
          <span className="glow-dot mb-1 h-7 w-7 shrink-0" />
          <div className="rounded-2xl rounded-bl-md border border-violet-300/15 bg-[#172231]/92 px-4 py-3 text-xs leading-5 text-white/86 shadow-xl backdrop-blur-xl sm:text-sm sm:leading-6">
            {t('homepageInteractions.heresYourMealPlanHoney')}
          </div>
        </div>
      </div>
    </div>
  );
}
