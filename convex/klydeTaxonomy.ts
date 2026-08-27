/**
 * Taxonomie Klyd — copie conforme du catalogue Vinted (racines Femmes, Hommes, Enfants),
 * sur 4 niveaux : Genre → Catégorie → Sous-catégorie → Sous-sous-catégorie.
 * Une liste vide signifie qu'il n'existe pas de niveau plus précis chez Vinted.
 *
 * ⚠️ FICHIER GÉNÉRÉ — ne pas éditer à la main.
 * Régénérer avec : node tools/fetch-vinted-taxonomy.mjs --write
 * (dépôt klyd-extension-googlechrome), puis déployer depuis ~/mesoutils.
 *
 * Source : https://www.vinted.fr/ (payload Next.js `catalogTree`)
 * Généré le : 2026-07-27
 */

export const KLYDE_TAXONOMY: KlydeTaxonomyTree = {
  Femmes: {
    Vêtements: {
      "Manteaux et vestes": ["Capes et ponchos", "Manteaux", "Vestes sans manches", "Vestes"],
      "Sweats et sweats à capuche": [
        "Sweats & sweats à capuche",
        "Sweats",
        "Kimonos",
        "Cardigans",
        "Boléros",
        "Vestes",
        "Autres pull-overs & sweat-shirts",
      ],
      "Blazers et tailleurs": [
        "Blazers",
        "Ensembles tailleur/pantalon",
        "Jupes et robes tailleurs",
        "Tailleurs pièces séparées",
        "Autres ensembles & tailleurs",
      ],
      Robes: [
        "Mini",
        "Midi",
        "Robes longues",
        "Pour occasions",
        "Robes d'été",
        "Robes d'hiver",
        "Robes chics",
        "Robes casual",
        "Robes sans bretelles",
        "Petites robes noires",
        "Robes en jean",
        "Autres robes",
      ],
      Jupes: ["Minijupes", "Jupes longueur genou", "Jupes midi", "Jupes longues", "Jupes asymétriques"],
      "Jupes-shorts": [],
      "Hauts et t-shirts": [
        "Chemises",
        "Blouses",
        "Vestes",
        "T-shirts",
        "Débardeurs",
        "Tuniques",
        "Tops courts",
        "Blouses manches courtes",
        "Blouses ¾",
        "Blouses manches longues",
        "Bodies",
        "Tops épaules dénudées",
        "Cols roulés",
        "Tops peplum",
        "Tops dos nu",
        "Autres hauts",
      ],
      Jeans: [
        "Jeans boyfriend",
        "Jeans courts",
        "Jeans évasés",
        "Jeans taille haute",
        "Jeans troués",
        "Jeans skinny",
        "Jeans droits",
        "Autre",
      ],
      "Pantalons et leggings": [
        "Pantalons courts & chinos",
        "Pantalons à jambes larges",
        "Pantalons skinny",
        "Pantalons ajustés",
        "Pantalons droits",
        "Pantalons en cuir",
        "Leggings",
        "Sarouels",
        "Autres pantalons",
      ],
      Shorts: [
        "Shorts taille basse",
        "Shorts taille haute",
        "Shorts longueur genou",
        "Short en jean",
        "Shorts en dentelle",
        "Shorts en cuir",
        "Shorts cargo",
        "Pantacourts",
        "Autres shorts",
      ],
      "Combinaisons et combishorts": ["Combinaisons", "Combi Shorts", "Autres combinaisons & combishorts"],
      "Maillots de bain": ["Une pièce", "Deux pièces", "Paréos et sarongs", "Autres"],
      "Lingerie et pyjamas": [
        "Soutiens-gorge",
        "Culottes",
        "Ensembles",
        "Gaines",
        "Pyjamas et tenues de nuit",
        "Peignoirs",
        "Collants",
        "Chaussettes",
        "Accessoires de lingerie",
        "Autres",
      ],
      Maternité: [
        "Tops maternité",
        "Robes maternité",
        "Jupes maternité",
        "Pantalons maternité",
        "Shorts maternité",
        "Combinaisons & combi shorts maternité",
        "Pulls à capuche & pulls maternité",
        "Manteaux & vestes maternité",
        "Maillots & tenues de plage maternité",
        "Sous-vêtements maternité",
        "Vêtements de sport",
      ],
      "Vêtements de sport": [
        "Vêtements d'extérieur",
        "Survêtements",
        "Pantalons & leggings",
        "Shorts",
        "Robes",
        "Jupes",
        "Hauts & t-shirts",
        "Maillots",
        "Sweats et sweats à capuche",
        "Accessoires de sports",
        "Brassières",
        "Autres",
      ],
      "Costumes et tenues particulières": [],
      Autres: [],
    },
    Chaussures: {
      Ballerines: [],
      "Mocassins et chaussures bateau": [],
      Bottes: [
        "Bottines",
        "Bottes mi-hautes",
        "Bottes hautes",
        "Cuissardes",
        "Bottes de neige",
        "Bottes de pluie",
        "Bottes de travail",
      ],
      "Mules et sabots": [],
      Espadrilles: [],
      "Claquettes et tongs": [],
      "Chaussures à talons": [],
      "Chaussures à lacets": [],
      "Babies et Mary-Jane": [],
      Sandales: [],
      "Chaussons et pantoufles": [],
      "Chaussures de sport": [
        "Chaussures de basket",
        "Chaussures d'escalade",
        "Chaussures de cyclisme",
        "Chaussures de danse",
        "Chaussures de foot",
        "Chaussures de golf",
        "Chaussures et bottes de randonnée",
        "Patins à glace",
        "Chaussures de foot en salle",
        "Chaussures de fitness",
        "Bottes de moto",
        "Patins à roulettes et rollers",
        "Chaussures de course",
        "Chaussures de ski",
        "Bottes de snowboard",
        "Chaussures aquatiques",
        "Chaussures de tennis",
      ],
      Baskets: [],
    },
    Sacs: {
      "Sacs à dos": [],
      "Sacs de plage": [],
      Mallettes: [],
      "Sacs seau": [],
      "Sacs banane": [],
      Pochettes: [],
      "Housses pour vêtements": [],
      "Sacs de sport": [],
      "Sacs à main": [],
      Besaces: [],
      "Fourre-tout et sacs marins": [],
      "Sacs de voyage": [],
      "Trousses à maquillage": [],
      "Cartables et sacoches": [],
      "Sacs à bandoulière": [],
      "Sacs fourre-tout": [],
      "Porte-monnaie": [],
      Wristlets: [],
    },
    Accessoires: {
      "Bandanas et foulards pour cheveux": [],
      Ceintures: [],
      Gants: [],
      "Accessoires pour cheveux": [],
      "Mouchoirs de poche": [],
      "Chapeaux & casquettes": ["Cagoules", "Bonnets", "Casquettes", "Cache-oreilles", "Fascinators", "Chapeaux", "Bandeaux"],
      Bijoux: [
        "Bracelets de cheville",
        "Bijoux de corps",
        "Bracelets",
        "Broches",
        "Breloques et pendentifs",
        "Boucles d'oreilles",
        "Ensembles de bijoux",
        "Colliers",
        "Bagues",
        "Autres bijoux",
      ],
      "Porte-clés": [],
      "Écharpes et châles": [],
      "Lunettes de soleil": [],
      Parapluies: [],
      Montres: [],
      "Autres accessoires": [],
    },
    Beauté: {
      Maquillage: [],
      Parfums: [],
      "Soins du visage": [],
      "Accessoires de beauté": [
        "Accessoires soins capillaires",
        "Accessoires soins du visage",
        "Accessoires soins corporels",
        "Accessoires soins des ongles",
        "Accessoires maquillage",
      ],
      "Soin mains": [],
      Manucure: [],
      "Soins du corps": [],
      "Soins cheveux": [],
      "Autres cosmétiques et accessoires": [],
    },
  },
  Hommes: {
    Vêtements: {
      Jeans: ["Jeans troués", "Jeans skinny", "Jeans slim", "Jeans coupe droite"],
      "Manteaux et vestes": ["Manteaux", "Vestes sans manches", "Vestes", "Ponchos"],
      "Hauts et t-shirts": ["Chemises", "T-shirts", "Polos", "T-shirts sans manches"],
      "Costumes et blazers": [
        "Blazers",
        "Pantalons de costume",
        "Gilets de costume",
        "Ensembles costume",
        "Costumes de mariage",
        "Autres",
      ],
      "Sweats et pulls": [
        "Sweats",
        "Pulls et pulls à capuche",
        "Pulls à capuche avec zip",
        "Cardigans",
        "Pulls ras de cou",
        "Sweats à col V",
        "Pulls à col roulé",
        "Sweats longs",
        "Pulls d'hiver",
        "Vestes",
        "Autres",
      ],
      Pantalons: [
        "Chinos",
        "Jogging",
        "Pantalons skinny",
        "Pantacourts",
        "Pantalons de costume",
        "Pantalons à jambes larges",
        "Autres pantalons",
      ],
      Shorts: ["Shorts cargo", "Shorts chino", "Shorts en jean", "Autres shorts"],
      "Sous-vêtements et chaussettes": ["Sous-vêtements", "Chaussettes", "Peignoirs", "Autres"],
      Pyjamas: ["Pyjamas une-pièce", "Bas de pyjama", "Ensembles de pyjamas", "Hauts de pyjama"],
      "Maillots de bain": [],
      "Vêtements de sport et accessoires": [
        "Vêtements d'extérieur",
        "Survêtements",
        "Pantalons",
        "Shorts",
        "Hauts et t-shirts",
        "Maillots",
        "Pulls & sweats",
        "Accessoires de sports",
        "Autres",
      ],
      "Vêtements spécialisés et costumes": [],
      Autres: [],
    },
    Chaussures: {
      "Mocassins et chaussures bateau": [],
      Bottes: [
        "Bottines Chelsea et sans lacets",
        "Bottines à lacets",
        "Bottes de neige",
        "Bottes de pluie",
        "Bottes de travail",
      ],
      "Mules et sabots": [],
      Espadrilles: [],
      "Claquettes et tongs": [],
      "Chaussures habillées": [],
      Sandales: [],
      "Chaussons et pantoufles": [],
      "Chaussures de sport": [
        "Chaussures de basket",
        "Chaussures d'escalade",
        "Chaussures de cyclisme",
        "Chaussures de danse",
        "Chaussures de foot",
        "Chaussures de golf",
        "Chaussures et bottes de randonnée",
        "Patins à glace",
        "Chaussures de foot en salle",
        "Chaussures de fitness",
        "Bottes de moto",
        "Patins à roulettes et rollers",
        "Chaussures de course",
        "Bottes de ski",
        "Bottes de snowboard",
        "Chaussures aquatiques",
        "Chaussures de tennis",
      ],
      Baskets: [],
    },
    Accessoires: {
      "Sacs et sacoches": [
        "Sacs à dos",
        "Mallettes",
        "Sacs banane",
        "Housses pour vêtements",
        "Sacs de sport",
        "Fourre-tout et sacs marins",
        "Bagages et valises",
        "Cartables et sacoches",
        "Sacs à bandoulière",
        "Porte-monnaie",
      ],
      "Bandanas et foulards pour cheveux": [],
      Ceintures: [],
      Bretelles: [],
      Gants: [],
      "Mouchoirs de poche": [],
      "Chapeaux et casquettes": ["Cagoules", "Bonnets", "Casquettes", "Chapeaux"],
      Bijoux: [
        "Bracelets",
        "Breloques et pendentifs",
        "Boutons de manchette",
        "Boucles d'oreilles",
        "Colliers",
        "Bagues",
        "Autre",
      ],
      "Pochettes de costume": [],
      "Écharpes et châles": [],
      "Lunettes de soleil": [],
      "Cravates et nœuds papillons": [],
      Montres: [],
      Autres: [],
    },
    Soins: {
      "Soins visage": [],
      Accessoires: ["Accessoires de rasage", "Accessoires de toilette", "Autres accessoires beauté"],
      "Soins cheveux": [],
      "Soins du corps": [],
      "Soins mains et ongles": [],
      Parfums: [],
      Maquillage: [],
      Coffrets: [],
      "Autres cosmétiques": [],
    },
  },
  Enfants: {
    "Vêtements pour filles": {
      "Bébé filles": ["Combinaisons", "Bodies", "Grenouillères", "Ensembles", "Autre"],
      Chaussures: [
        "Chaussures bébé",
        "Bottes",
        "Mules et sabots",
        "Chaussures plates",
        "Sandales, claquettes et tongs",
        "Chaussures habillées",
        "Chaussures à talons",
        "Chaussons et pantoufles",
        "Chaussures de sport",
        "Baskets",
      ],
      "Vêtements d'extérieur": ["Manteaux", "Vestes sans manches", "Vestes", "Vêtements de pluie", "Vêtements de ski"],
      "Pulls & sweats": [
        "Pulls",
        "Pulls col V",
        "Pulls à col roulé",
        "Gilets zippés",
        "Boléros",
        "Pulls à capuche & sweatshirts",
        "Gilets",
        "Autre",
      ],
      "Chemises et t-shirts": [
        "T-shirts",
        "Polos",
        "Chemises",
        "Chemises manches courtes",
        "Chemises manches longues",
        "Chemises sans manches",
        "Tuniques",
        "Autre",
      ],
      Robes: ["Robes courtes", "Robes longues"],
      Jupes: [],
      "Pantalons et shorts": [
        "Jeans",
        "Jeans slim",
        "Pantalons pattes d'éléphant",
        "Leggings",
        "Salopettes",
        "Shorts et pantacourts",
        "Sarouels",
        "Autres",
      ],
      "Sacs et sacs à dos": [],
      Accessoires: [
        "Casquettes et chapeaux",
        "Gants",
        "Écharpes et châles",
        "Ceintures",
        "Bandeaux et barrettes cheveux",
        "Porte-monnaie",
        "Bijoux",
        "Autres accessoires",
      ],
      "Équipements de natation": ["Maillot de bain 1 pièce", "Maillot de bain 2 pièces", "Peignoirs"],
      "Sous-vêtements": ["Chaussettes", "Collants", "Culottes", "Autre"],
      "Pyjamas et chemises de nuit": ["Pyjamas une pièce", "Pyjamas deux pièces", "Chemises de nuit"],
      "Vêtements de sport": [],
      "Lots de vêtements": [],
      "Jumeaux et plus": [],
      Déguisements: [],
      "Tenues de soirée": [],
      Autres: [],
    },
    "Vêtements pour garçons": {
      "Bébé garçons": ["Combinaisons", "Bodies", "Grenouillères", "Ensembles", "Autre"],
      Chaussures: [
        "Chaussures bébé",
        "Mocassins et chaussures bateau",
        "Bottes",
        "Espadrilles",
        "Sandales, claquettes et tongs",
        "Chaussures habillées",
        "Chaussons et pantoufles",
        "Chaussures de sport",
        "Baskets",
      ],
      "Vêtements d'extérieur": ["Manteaux", "Vestes sans manches", "Vestes", "Vêtements de pluie", "Vêtements de ski"],
      "Pulls & sweats": [
        "Pulls",
        "Pulls col V",
        "Pulls à col roulé",
        "Gilets zippés",
        "Pulls à capuche et sweatshirts",
        "Gilets",
        "Autre",
      ],
      "Chemises et t-shirts": [
        "T-shirts",
        "Polos",
        "Chemises",
        "Chemises manches courtes",
        "Chemises manches longues",
        "Chemises sans manches",
        "Autre",
      ],
      "Pantalons et shorts": [
        "Jeans",
        "Jeans slim",
        "Pantalons pattes d'éléphant",
        "Leggings",
        "Salopettes",
        "Shorts et pantacourts",
        "Sarouels",
        "Autres",
      ],
      "Sacs et sacs à dos": [],
      Accessoires: [
        "Casquettes et chapeaux",
        "Gants",
        "Écharpes et châles",
        "Ceintures",
        "Porte-monnaie",
        "Nœuds papillon et cravattes",
        "Autres accessoires",
      ],
      "Équipements de natation": ["Maillots de bain", "Peignoirs"],
      "Sous-vêtements": ["Chaussettes", "Collants", "Culottes", "Autre"],
      Pyjamas: ["Pyjamas une pièce", "Pyjamas deux pièces"],
      "Vêtements de sport": [],
      "Lots de vêtements": [],
      "Jumeaux et plus": [],
      Déguisements: [],
      "Tenues de soirée": [],
      Autres: [],
    },
    "Jeux et jouets": {
      "Figurines et accessoires": ["Figurines", "Accessoires", "Sets de jeux"],
      "Loisirs créatifs": [
        "Tabliers et blouses",
        "Perles et fabrication de bijoux",
        "Argile et pâte à modeler",
        "Kits créatifs",
        "Peinture et dessin",
        "Tableaux et ardoises",
        "Pochoirs et tampons",
        "Gommettes et accessoires de papeterie",
      ],
      "Activités et jouets pour bébé": [
        "Centres d'activités et trotteurs",
        "Tapis d'éveil et d'activités",
        "Jouets de bain",
        "Bouncers, jumpers & swings",
        "Planches d'activités",
        "Push & pull toys",
        "Hochets",
        "Sorting & stacking toys",
        "Jouets de dentition",
      ],
      "Jeux de construction": [],
      "Poupées, poupons et accessoires": [
        "Poupées et poupons",
        "Accessoires pour poupée et poupon",
        "Meubles et accessoires pour maison de poupée",
        "Maisons de poupées",
        "Kits de jeu pour poupée et poupon",
      ],
      "Déguisements et jeux de rôle": [
        "Déguisements",
        "Tentes et tunnels de jeux",
        "Toy food, cookware, & dishes",
        "Boîtes à bijoux pour enfant",
        "Cuisines pour enfant",
        "Matériel de bricolage pour enfant",
      ],
      "Jeux éducatifs": [
        "Cartes flash",
        "Kaléidoscopes et prismes",
        "Jeux de lecture et d'écriture",
        "Jeux scientifiques et STEM",
        "Autres jeux éducatifs",
      ],
      "Jeux et jouets électroniques": [
        "Musiques et histoires",
        "Peluches interactives",
        "Équipements de karaoké pour enfants",
        "Boîtes à musique et histoires",
        "Jouets télécommandés",
        "Appareils photo pour enfant",
        "Talkies-walkies",
        "Autres jeux et jouets électroniques",
      ],
      "Jeux/jouets musicaux et instruments": [],
      "Jeux de cirque, fidgets et gadgets": [
        "Fidgets",
        "Kits de jonglage",
        "Coffrets et accessoires de magie",
        "Farces et attrapes",
        "Slime & putty",
        "Yoyos",
        "Autres jeux fantaisie et gadgets",
      ],
      "Jeux de sport et de plein air": [
        "Piscines à balles et accessoires",
        "Jeux d'eau et de plage",
        "Machines et flacons à bulles",
        "Pistolets à projectiles en mousse et accessoires",
        "Autres jeux de plein air",
        "Cerfs-volants et fusées",
        "Jeux de sable et d'eau",
        "Jeux de sport",
      ],
      Peluches: [],
      "Voitures, trains et autres véhicules": ["Avions", "Voitures", "Trains", "Camions", "Circuits et garages", "Autres véhicules"],
    },
    "Poussettes, porte-bébé et sièges auto": {
      "Porte-bébé et écharpes": ["Slings et écharpes", "Porte-bébé souples", "Porte-bébé de hanche", "Backpack carriers"],
      "Poussettes et landaus": [],
      "Accessoires de poussette": [
        "Nacelles, cosys et adaptateurs",
        "Planches à roulettes et sièges supplémentaires",
        "Habillages pluie, capotes et ombrelles",
        "Porte-gobelet et plateaux",
        "Chancelières pour poussette",
        "Organisateurs et filets",
        "Pièces détachées",
      ],
      "Sièges auto": [],
      Rehausseurs: [],
      "Accessoires pour siège auto": [
        "Miroirs de voiture",
        "Car sun shades & screens",
        "Réducteurs pour siège auto",
        "Car seat bases",
        "Housses pour siège auto",
        "Car seat footmuffs",
        "Autres accessoires pour voiture",
      ],
    },
    "Meubles et décoration": {
      "Matelas pour lits bébé et enfant": ["Matelas pour lit à barreaux", "Matelas pour berceau", "Matelas pour lit enfant"],
      "Tapis de sol et dalles en mousse": [],
      Parcs: [],
      "Réducteurs de lit": [],
      "Décoration et souvenirs": [
        "Albums photo",
        "Toises",
        "Mobiles",
        "Cartes étapes et accessoires photo",
        "Tirelires",
        "Cadres photo",
        "Décorations murales",
      ],
      "Chambre de bébé": ["Cododos", "Tables à langer", "Lits à barreaux", "Berceaux", "Lits enfant"],
      Tapis: [],
      "Chaises et fauteuils": [],
      "Modules de motricité": [],
      Étagères: [],
      "Tables et bureaux": [],
      Armoires: [],
    },
    "Bain et change": {
      "Sacs à langer": [],
      Bain: ["Bath tubs & seats", "Accessoires de bain", "Serviettes de bain", "Washcloths"],
      "Changing mats & covers": ["Matelas à langer", "Housses de matelas à langer", "Matelas à langer nomades"],
      Couches: ["Couches lavables", "Couches de bain", "Couches jetables"],
      "Poubelles et rangements pour couches": [
        "Poubelles à couches",
        "Accessoires pour poubelles à couches",
        "Rangements pour couches",
        "Chauffe-lingettes et rangements pour lingettes",
      ],
      "Pots et réducteurs": [],
      "Hygiène et soin": ["Accessoires de soin", "Shampoings, savons et soins pour la peau", "Baby wipes"],
      Marchepieds: [],
    },
    "Sécurité bébé et enfant": {
      "Barrières de sécurité": [],
      "Accessoires de sécurité": [],
      "Protections auditives": [],
      "Laisses et harnais": [],
    },
    "Santé et grossesse": {
      Humidificateurs: [],
      "Mouche-bébé": [],
      "Soins du post-partum": [],
      "Coussins de grossesse": [],
      "Pregnancy support belts": [],
      Balances: [],
      Thermomètres: [],
    },
    "Allaitement et alimentation": {
      "Mixeurs et robots cuiseurs pour bébé": [],
      Bavoirs: [],
      "Alimentation au biberon": [
        "Biberons",
        "Tétines",
        "Séchoirs à linge",
        "Goupillons",
        "Chauffe-biberon",
        "Préparateurs de biberons",
        "Boîtes doseuses",
      ],
      Allaitement: [
        "Tire-lait",
        "Accessoires pour tire-lait",
        "Couvertures d'allaitement",
        "Coussinets d'allaitement et protège-mamelon",
      ],
      "Repas de bébé": ["Couverts", "Assiettes et bols", "Coffrets repas", "Tasses d'apprentissage", "Gourdes"],
      "Coussins et couvertures d'allaitement": [],
      Sucettes: [],
      "Accessoires pour sucettes": [],
      "Chaises hautes": [],
      "Accessoires pour chaise haute": [],
      Langes: [],
      Stérilisateurs: [],
    },
    "Sommeil et literie": {
      Babyphones: [],
      "Barrières de lit": [],
      "Linge de lit, couvertures et plaids": ["Couvertures et plaids", "Draps-housses et alèses", "Oreillers", "Draps"],
      "Stores occultants": [],
      "Coussins chauffants et bouillottes": [],
      Veilleuses: [],
      "Gigoteuses et turbulettes": [],
      "Sacs de couchage": [],
      "Couvertures d'emmaillotage": [],
      "Générateurs de bruits blancs": [],
    },
    "Fournitures scolaires": {
      "Boîtes et sacs à repas": [],
      Cartables: [],
      "Fournitures scolaires": [],
    },
    "Autres articles pour bébé et enfant": {},
  },
};

export type KlydeTaxonomyTree = Record<string, Record<string, Record<string, string[]>>>;

export const KLYDE_GENDERS = Object.keys(KLYDE_TAXONOMY);

const normalize = (value?: string | null) => value?.trim().normalize("NFC") ?? "";

function taxonomyForGender(gender?: string | null) {
  return KLYDE_TAXONOMY[normalize(gender)];
}

export function klydeCategories(gender?: string | null) {
  const selected = taxonomyForGender(gender);
  if (selected) return Object.keys(selected);
  return Array.from(new Set(Object.values(KLYDE_TAXONOMY).flatMap((tree) => Object.keys(tree))));
}

export function klydeSubcategories(gender: string | null | undefined, category: string | null | undefined) {
  const normalizedCategory = normalize(category);
  const selected = taxonomyForGender(gender);
  if (selected?.[normalizedCategory]) return Object.keys(selected[normalizedCategory]);
  return Array.from(new Set(Object.values(KLYDE_TAXONOMY).flatMap((tree) => {
    const branch = tree[normalizedCategory];
    return branch ? Object.keys(branch) : [];
  })));
}

export function klydeSubsubcategories(gender: string | null | undefined, category: string | null | undefined, subcategory: string | null | undefined): string[] {
  const branch = taxonomyForGender(gender)?.[normalize(category)];
  const leaves = branch?.[normalize(subcategory)];
  return leaves ? [...leaves] : [];
}

export function isKlydeTaxonomyChoice(gender: string | null | undefined, category: string, subcategory?: string | null, subsubcategory?: string | null) {
  const branch = taxonomyForGender(gender)?.[normalize(category)];
  if (!branch) return false;
  if (!subcategory) return true;
  const leaves = branch[normalize(subcategory)];
  if (!leaves) return false;
  return !subsubcategory || leaves.length === 0 || leaves.includes(normalize(subsubcategory));
}

/** Poids moyen en kg d'un article seul. Les chaussures sont estimées par paire. */
export function klydeAverageWeightKg(category?: string | null, subcategory?: string | null, subsubcategory?: string | null) {
  const label = `${normalize(category)} ${normalize(subcategory)} ${normalize(subsubcategory)}`.toLocaleLowerCase("fr-FR");
  const has = (pattern: RegExp) => pattern.test(label);
  if (has(/robe de mariée|robes de mariée/)) return 1.8;
  if (has(/robe de soirée|manteau|parka|doudoune|peignoir|gigoteuse/)) return 1.2;
  if (has(/bottes de pluie|bottes|chaussures de sécurité/)) return 1.5;
  if (has(/bottines|baskets montantes/)) return 1.1;
  if (has(/baskets|derbies|richelieus|mocassins|chaussures/)) return 0.8;
  if (has(/escarpins|sandales|mules|sabots|espadrilles|ballerines|tongs/)) return 0.55;
  if (has(/sacs de voyage/)) return 1.1;
  if (has(/sacs pour ordinateur|sacs à dos|sacs cabas/)) return 0.75;
  if (has(/sac|pochette|portefeuille|trousse/)) return 0.4;
  if (has(/jeans|salopettes|pantalons en cuir|pantalons cargo|pantalons de travail/)) return 0.65;
  if (has(/pantalon|chino|jogging|legging|pantacourt/)) return 0.45;
  if (has(/combinaison|costume complet|ensemble/)) return 0.8;
  if (has(/blazer|veste de costume|vestes en cuir|blouson|bomber/)) return 0.75;
  if (has(/veste|trench|imperméable|cape|poncho|polaire/)) return 0.65;
  if (has(/pull|cardigan|gilet|sweat|col roulé/)) return 0.55;
  if (has(/robe longue|robe pull|robes longues/)) return 0.55;
  if (has(/robe/)) return 0.35;
  if (has(/jupe en jean|jupe en cuir/)) return 0.45;
  if (has(/jupe/)) return 0.3;
  if (has(/short en jean|short habillé/)) return 0.35;
  if (has(/short/)) return 0.25;
  if (has(/chemise|blouse|tunique|polo/)) return 0.3;
  if (has(/tee-shirts|tee-shirt|t-shirt|débardeur|top|body/)) return 0.2;
  if (has(/pyjama|grenouillère|barboteuse/)) return 0.35;
  if (has(/soutien|culotte|lingerie|maillot|bikini|paréo|collant|chaussettes/)) return 0.15;
  if (has(/bijou|montre|lunettes|porte-clés|accessoires pour cheveux/)) return 0.08;
  if (has(/ceinture|cravate|bretelles|gants|bonnet|casquette|chapeau|écharpe|foulard|parapluie/)) return 0.2;
  if (has(/bébé|naissance|prématuré|moufles/)) return 0.15;
  return 0.4;
}
