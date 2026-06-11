import type { CategoryGroupEntity } from '@actual-app/core/types/models';

export type CategoryFormulaBadges = Record<string, string>;

export function getCategoryFormulaBadges(
  categoryGroups: CategoryGroupEntity[],
): CategoryFormulaBadges {
  const badges: CategoryFormulaBadges = {};

  for (const group of categoryGroups) {
    badges[`category-group:${group.id}`] = group.name;
    for (const category of group.categories ?? []) {
      badges[`category:${category.id}`] = `${group.name} / ${category.name}`;
    }
  }

  return badges;
}
