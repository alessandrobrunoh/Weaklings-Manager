//! Local Albion equipment catalog service.
//!
//! The historical `/api/openalbion/*` endpoints are kept as a compatibility surface, but all
//! data is read from the curated catalog bundled with the application. This module never contacts
//! the third-party OpenAlbion API.

use super::catalog::{
    OpenAlbionCategory, OpenAlbionItem, OpenAlbionItemType, OpenAlbionWeapon,
    OpenAlbionWeaponFilters, OpenAlbionWeaponStats,
};
use crate::errors::AppError;
use crate::pagination::{PaginatedData, PaginationParams};
use std::sync::OnceLock;

/// Service exposing the local Albion equipment catalog.
#[derive(Clone, Copy, Default)]
pub struct OpenAlbionService;

impl OpenAlbionService {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Lists local weapons, optionally filtered by tier or name, with pagination.
    pub async fn list_weapons(
        &self,
        filters: &OpenAlbionWeaponFilters,
        query: Option<&str>,
        pagination: &PaginationParams,
    ) -> Result<PaginatedData<OpenAlbionWeapon>, AppError> {
        let mut weapons = catalog_items()
            .iter()
            .filter(|item| item.item_type.as_deref() == Some("weapon"))
            .map(|item| OpenAlbionWeapon {
                id: item.id,
                name: item.name.clone(),
                tier: item.tier.clone(),
                item_power: item.item_power,
                icon: item.icon.clone(),
            })
            .collect::<Vec<_>>();

        filter_items(&mut weapons, filters.tier, query);
        paginate(weapons, pagination)
    }

    /// Lists the local top-level categories. Category IDs are stable compatibility values; the
    /// curated catalog intentionally does not depend on third-party category membership.
    pub async fn list_categories(
        &self,
        category_type: Option<&str>,
    ) -> Result<Vec<OpenAlbionCategory>, AppError> {
        const CATEGORIES: [(&str, i64, &str); 4] = [
            ("weapon", 1, "Weapons"),
            ("armor", 2, "Armor"),
            ("accessory", 3, "Accessories"),
            ("consumable", 4, "Consumables"),
        ];

        Ok(CATEGORIES
            .into_iter()
            .filter(|(kind, _, _)| category_type.is_none_or(|requested| requested == *kind))
            .map(|(kind, id, name)| OpenAlbionCategory {
                id,
                name: name.to_string(),
                category_type: Some(kind.to_string()),
                subcategories: Vec::new(),
            })
            .collect())
    }

    /// Lists local items of any supported type, optionally filtered by tier or name, with pagination.
    pub async fn list_items(
        &self,
        item_type: OpenAlbionItemType,
        filters: &OpenAlbionWeaponFilters,
        query: Option<&str>,
        pagination: &PaginationParams,
    ) -> Result<PaginatedData<OpenAlbionItem>, AppError> {
        let requested_type = item_type.as_str();
        let mut items = catalog_items()
            .iter()
            .filter(|item| item.item_type.as_deref() == Some(requested_type))
            .cloned()
            .collect::<Vec<_>>();

        filter_items(&mut items, filters.tier, query);
        paginate(items, pagination)
    }

    /// Returns every item in the curated local catalog.
    pub async fn list_catalog(&self) -> Result<Vec<OpenAlbionItem>, AppError> {
        Ok(catalog_items().to_vec())
    }

    /// Preserves the historical stats endpoint without making a remote request. The local catalog
    /// contains item identity and render metadata, but not per-quality combat stat tables, so a
    /// known weapon returns an empty compatible array and an unknown ID returns 404.
    pub async fn get_weapon_stats(
        &self,
        weapon_id: i64,
    ) -> Result<Vec<OpenAlbionWeaponStats>, AppError> {
        if catalog_items()
            .iter()
            .any(|item| item.id == weapon_id && item.item_type.as_deref() == Some("weapon"))
        {
            Ok(Vec::new())
        } else {
            Err(AppError::NotFound(format!("weapon {weapon_id} not found")))
        }
    }
}

fn catalog_items() -> &'static [OpenAlbionItem] {
    static CATALOG: OnceLock<Vec<OpenAlbionItem>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let mut items: Vec<OpenAlbionItem> = serde_json::from_str(include_str!("catalog.json"))
            .expect("bundled Albion catalog must be valid JSON");
        for item in &mut items {
            if let Some(identifier) = item.identifier.as_deref() {
                item.name = normalize_name(identifier, &item.name);
                item.icon = Some(render_icon_url(identifier));
            }
        }
        items
    })
}

fn filter_items<T>(items: &mut Vec<T>, tier: Option<i64>, query: Option<&str>)
where
    T: CatalogItem,
{
    if let Some(tier) = tier {
        let needle = tier.to_string();
        items.retain(|item| item.tier().is_some_and(|value| value.starts_with(&needle)));
    }
    if let Some(query) = query.filter(|value| !value.trim().is_empty()) {
        let needle = query.trim().to_lowercase();
        items.retain(|item| item.name().to_lowercase().contains(&needle));
    }
}

fn paginate<T>(items: Vec<T>, pagination: &PaginationParams) -> Result<PaginatedData<T>, AppError> {
    let total_items = items.len() as u64;
    let limit = pagination.limit();
    let page = pagination.offset_page();
    let total_pages = if limit == 0 {
        0
    } else {
        total_items.div_ceil(limit)
    };
    let start = page.saturating_mul(limit) as usize;
    let paged_items = items.into_iter().skip(start).take(limit as usize).collect();

    Ok(PaginatedData::new(
        paged_items,
        total_items,
        total_pages,
        page + 1,
        limit,
    ))
}

trait CatalogItem {
    fn name(&self) -> &str;
    fn tier(&self) -> Option<&str>;
}

impl CatalogItem for OpenAlbionItem {
    fn name(&self) -> &str {
        &self.name
    }

    fn tier(&self) -> Option<&str> {
        self.tier.as_deref()
    }
}

impl CatalogItem for OpenAlbionWeapon {
    fn name(&self) -> &str {
        &self.name
    }

    fn tier(&self) -> Option<&str> {
        self.tier.as_deref()
    }
}

impl OpenAlbionItemType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Weapon => "weapon",
            Self::Armor => "armor",
            Self::Accessory => "accessory",
            Self::Consumable => "consumable",
        }
    }
}

fn normalize_name(identifier: &str, fallback: &str) -> String {
    let uppercase_identifier = identifier.trim().to_ascii_uppercase();
    let base = uppercase_identifier
        .trim_start_matches("T1_")
        .trim_start_matches("T2_")
        .trim_start_matches("T3_")
        .trim_start_matches("T4_")
        .trim_start_matches("T5_")
        .trim_start_matches("T6_")
        .trim_start_matches("T7_")
        .trim_start_matches("T8_");

    let exact = match base {
        "MAIN_CURSEDSTAFF" => Some("Cursed Staff"),
        "2H_CURSEDSTAFF" => Some("Great Cursed Staff"),
        "2H_DEMONICSTAFF" => Some("Demonic Staff"),
        "MAIN_CURSEDSTAFF_UNDEAD" => Some("Lifecurse Staff"),
        "2H_SKULLORB_HELL" => Some("Cursed Skull"),
        "2H_CURSEDSTAFF_MORGANA" => Some("Damnation Staff"),
        "MAIN_CURSEDSTAFF_AVALON" => Some("Shadowcaller"),
        "MAIN_CURSEDSTAFF_CRYSTAL" => Some("Rotcaller Staff"),
        "MAIN_FIRESTAFF" => Some("Fire Staff"),
        "2H_FIRESTAFF" => Some("Great Fire Staff"),
        "2H_INFERNOSTAFF" => Some("Infernal Staff"),
        "MAIN_FIRESTAFF_KEEPER" => Some("Wildfire Staff"),
        "2H_FIRESTAFF_HELL" => Some("Brimstone Staff"),
        "2H_INFERNOSTAFF_MORGANA" => Some("Blazing Staff"),
        "2H_FIRE_RINGPAIR_AVALON" => Some("Dawnsong"),
        "MAIN_FIRESTAFF_CRYSTAL" => Some("Flamewalker Staff"),
        "MAIN_FROSTSTAFF" => Some("Frost Staff"),
        "2H_FROSTSTAFF" => Some("Great Frost Staff"),
        "2H_GLACIALSTAFF" => Some("Glacial Staff"),
        "MAIN_FROSTSTAFF_KEEPER" => Some("Hoarfrost Staff"),
        "2H_ICEGAUNTLETS_HELL" => Some("Icicle Staff"),
        "2H_ICECRYSTAL_UNDEAD" => Some("Permafrost Prism"),
        "MAIN_FROSTSTAFF_AVALON" => Some("Chillhowl"),
        "2H_FROSTSTAFF_CRYSTAL" => Some("Arctic Staff"),
        "MAIN_ARCANESTAFF" => Some("Arcane Staff"),
        "2H_ARCANESTAFF" => Some("Great Arcane Staff"),
        "2H_ENIGMATICSTAFF" => Some("Enigmatic Staff"),
        "MAIN_ARCANESTAFF_UNDEAD" => Some("Witchwork Staff"),
        "2H_ARCANESTAFF_HELL" => Some("Occult Staff"),
        "2H_ENIGMATICORB_MORGANA" => Some("Malevolent Locus"),
        "2H_ARCANE_RINGPAIR_AVALON" => Some("Evensong"),
        "2H_ARCANESTAFF_CRYSTAL" => Some("Astral Staff"),
        "MAIN_HOLYSTAFF" => Some("Holy Staff"),
        "2H_HOLYSTAFF" => Some("Great Holy Staff"),
        "2H_DIVINESTAFF" => Some("Divine Staff"),
        "MAIN_HOLYSTAFF_MORGANA" => Some("Lifetouch Staff"),
        "2H_HOLYSTAFF_HELL" => Some("Fallen Staff"),
        "2H_HOLYSTAFF_UNDEAD" => Some("Redemption Staff"),
        "MAIN_HOLYSTAFF_AVALON" => Some("Hallowfall"),
        "2H_HOLYSTAFF_CRYSTAL" => Some("Exalted Staff"),
        "MAIN_NATURESTAFF" => Some("Nature Staff"),
        "2H_NATURESTAFF" => Some("Great Nature Staff"),
        "2H_WILDSTAFF" => Some("Wild Staff"),
        "MAIN_NATURESTAFF_KEEPER" => Some("Druidic Staff"),
        "2H_NATURESTAFF_HELL" => Some("Blight Staff"),
        "2H_NATURESTAFF_KEEPER" => Some("Rampant Staff"),
        "MAIN_NATURESTAFF_AVALON" => Some("Ironroot Staff"),
        "MAIN_NATURESTAFF_CRYSTAL" => Some("Forgebark Staff"),
        "MAIN_SWORD_CRYSTAL" => Some("Infinity Blade"),
        "2H_QUARTERSTAFF" => Some("Quarterstaff"),
        "2H_IRONCLADEDSTAFF" => Some("Iron-clad Staff"),
        "2H_DOUBLEBLADEDSTAFF" => Some("Double Bladed Staff"),
        "2H_COMBATSTAFF_MORGANA" => Some("Black Monk Stave"),
        "2H_TWINSCYTHE_HELL" => Some("Soulscythe"),
        "2H_ROCKSTAFF_KEEPER" => Some("Staff of Balance"),
        "2H_QUARTERSTAFF_AVALON" => Some("Grailseeker"),
        "2H_DOUBLEBLADEDSTAFF_CRYSTAL" => Some("Phantom Twinblade"),
        "2H_KNUCKLES_SET1" => Some("Brawler Gloves"),
        "2H_KNUCKLES_SET2" => Some("Battle Bracers"),
        "2H_KNUCKLES_SET3" => Some("Spiked Gauntlets"),
        "2H_KNUCKLES_KEEPER" => Some("Ursine Maulers"),
        "2H_KNUCKLES_HELL" => Some("Hellfire Hands"),
        "2H_KNUCKLES_MORGANA" => Some("Ravenstrike Cestus"),
        "2H_KNUCKLES_AVALON" => Some("Fists of Avalon"),
        "2H_KNUCKLES_CRYSTAL" => Some("Forcepulse Bracers"),
        "2H_SHAPESHIFTER_SET1" => Some("Prowling Staff"),
        "2H_SHAPESHIFTER_SET2" => Some("Rootbound Staff"),
        "2H_SHAPESHIFTER_SET3" => Some("Primal Staff"),
        "2H_SHAPESHIFTER_MORGANA" => Some("Bloodmoon Staff"),
        "2H_SHAPESHIFTER_HELL" => Some("Hellspawn Staff"),
        "2H_SHAPESHIFTER_KEEPER" => Some("Earthrune Staff"),
        "2H_SHAPESHIFTER_AVALON" => Some("Lightcaller"),
        "2H_SHAPESHIFTER_CRYSTAL" => Some("Stillgaze Staff"),
        _ => None,
    };
    if let Some(name) = exact {
        return name.to_string();
    }

    let curated_name = fallback.trim();
    let technical_name = base.replace('_', " ");
    if !curated_name.is_empty() && !curated_name.eq_ignore_ascii_case(&technical_name) {
        return curated_name.to_string();
    }

    let value = base
        .trim_start_matches("MAIN_")
        .trim_start_matches("2H_")
        .replace("DAGGERPAIR", "DAGGER PAIR")
        .replace("CLAWPAIR", "CLAW PAIR")
        .replace("RINGPAIR", "RING PAIR")
        .replace("CROSSBOW", " CROSSBOW")
        .replace("QUARTERSTAFF", " QUARTERSTAFF")
        .replace("NATURESTAFF", " NATURE STAFF")
        .replace("FIRESTAFF", " FIRE STAFF")
        .replace("FROSTSTAFF", " FROST STAFF")
        .replace("HOLYSTAFF", " HOLY STAFF")
        .replace("CURSEDSTAFF", " CURSED STAFF")
        .replace("ARCANESTAFF", " ARCANE STAFF")
        .replace("DEMONICSTAFF", " DEMONIC STAFF")
        .replace("WILDSTAFF", " WILD STAFF")
        .replace("DIVINESTAFF", " DIVINE STAFF")
        .replace("GLACIALSTAFF", " GLACIAL STAFF")
        .replace("ENIGMATICSTAFF", " ENIGMATIC STAFF")
        .replace('_', " ");
    let name = value
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => {
                    first.to_uppercase().collect::<String>() + &chars.as_str().to_ascii_lowercase()
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if name.is_empty() {
        fallback.trim().to_string()
    } else {
        name
    }
}

fn render_icon_url(identifier: &str) -> String {
    format!(
        "https://render.albiononline.com/v1/item/{}.png?quality=1&size=64",
        urlencoding::encode(identifier.trim())
    )
}
