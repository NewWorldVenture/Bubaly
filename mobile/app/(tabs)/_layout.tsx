import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../src/theme/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
const TABS: { name: string; title: string; icon: IconName; outline: IconName }[] = [
  { name: 'index', title: 'Today', icon: 'sunny', outline: 'sunny-outline' },
  { name: 'calendar', title: 'Calendar', icon: 'calendar', outline: 'calendar-outline' },
  { name: 'chores', title: 'Chores', icon: 'checkmark-circle', outline: 'checkmark-circle-outline' },
  { name: 'grocery', title: 'Grocery', icon: 'cart', outline: 'cart-outline' },
  { name: 'assistant', title: 'Assistant', icon: 'sparkles', outline: 'sparkles-outline' },
];

export default function TabsLayout() {
  const { colors } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brandText,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            tabBarIcon: ({ color, size, focused }) => <Ionicons name={focused ? tab.icon : tab.outline} size={size} color={color} />,
          }}
        />
      ))}
    </Tabs>
  );
}
