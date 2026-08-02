/**
 * Orchestrates bulk ingestion of free, public Texas property/parcel data
 * sources (Central Appraisal District bulk downloads, city/county ArcGIS
 * parcel layers, and Socrata open-data datasets) into
 * data/states/texas/processed/parcels/<county>/<source-id>.jsonl (one JSON
 * object per row, so million-row layers never need to fit in memory at
 * once). Output is partitioned by county, mirroring the
 * data/states/oklahoma/okcountyrecords/<county>/ convention used for the
 * Oklahoma real-time crawler.
 *
 * This is the "free bulk data" half of the Texas property-records strategy:
 *   - Appraisal/parcel data (owner, mailing address, situs address, legal
 *     description, assessed value) IS available for free from many CADs -
 *     handled here.
 *   - Deed/lien history is NOT free/bulk-downloadable statewide (County
 *     Clerks paywall it) - out of scope for this script; see
 *     scripts/query-socrata-deeds.ts for the (limited) Socrata-catalog-based
 *     discovery of any county clerk datasets that do exist.
 *
 * Each source is either:
 *   (a) an ArcGIS Server "query"-capable layer (city/county GIS parcel
 *       services), downloaded via scripts/lib/arcgis-bulk.ts,
 *   (b) a Socrata (SODA API) dataset, downloaded via scripts/lib/socrata-bulk.ts, or
 *   (c) a CAD-published downloadable ZIP of delimited text (the most common
 *       Texas CAD format), downloaded via scripts/lib/cad-zip-bulk.ts.
 *
 * Sources are intentionally kept in one place (SOURCES below) so new CADs
 * discovered later (e.g. via research into Harris/HCAD, Tarrant, Collin,
 * Bexar, etc.) can be added without changing the ingestion logic. Add a new
 * entry and rerun - already-downloaded sources are skipped unless --force.
 *
 * Usage:
 *   pnpm ingest-texas-bulk                  # run all configured sources
 *   pnpm ingest-texas-bulk -- --only=dallas-city-arcgis
 *   pnpm ingest-texas-bulk -- --force
 */
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { downloadArcgisLayer, type ArcgisSourceConfig } from './lib/arcgis-bulk';
import { downloadSocrataDataset, type SocrataSourceConfig } from './lib/socrata-bulk';
import { downloadCadZipSource, type CadZipSourceConfig } from './lib/cad-zip-bulk';

// Mirrors the data/states/oklahoma/okcountyrecords/<county>/ convention.
const OUT_DIR = path.join(process.cwd(), 'data', 'states', 'texas', 'txcountyrecords');

type Source =
	| ({ kind: 'arcgis'; county: string } & ArcgisSourceConfig)
	| ({ kind: 'socrata'; county: string } & SocrataSourceConfig)
	| ({ kind: 'cad-zip'; county: string } & CadZipSourceConfig);

export const TEXAS_COUNTIES = [
	'Anderson',
	'Andrews',
	'Angelina',
	'Aransas',
	'Archer',
	'Armstrong',
	'Atascosa',
	'Austin',
	'Bailey',
	'Bandera',
	'Bastrop',
	'Baylor',
	'Bee',
	'Bell',
	'Bexar',
	'Blanco',
	'Borden',
	'Bosque',
	'Bowie',
	'Brazoria',
	'Brazos',
	'Brewster',
	'Briscoe',
	'Brooks',
	'Brown',
	'Burleson',
	'Burnet',
	'Caldwell',
	'Calhoun',
	'Callahan',
	'Cameron',
	'Camp',
	'Carson',
	'Cass',
	'Castro',
	'Chambers',
	'Cherokee',
	'Childress',
	'Clay',
	'Cochran',
	'Coke',
	'Coleman',
	'Collin',
	'Collingsworth',
	'Colorado',
	'Comal',
	'Comanche',
	'Concho',
	'Cooke',
	'Coryell',
	'Cottle',
	'Crane',
	'Crockett',
	'Crosby',
	'Culberson',
	'Dallam',
	'Dallas',
	'Dawson',
	'Deaf Smith',
	'Delta',
	'Denton',
	'DeWitt',
	'Dickens',
	'Dimmit',
	'Donley',
	'Duval',
	'Eastland',
	'Ector',
	'Edwards',
	'Ellis',
	'El Paso',
	'Erath',
	'Falls',
	'Fannin',
	'Fayette',
	'Fisher',
	'Floyd',
	'Foard',
	'Fort Bend',
	'Franklin',
	'Freestone',
	'Frio',
	'Gaines',
	'Galveston',
	'Garza',
	'Gillespie',
	'Glasscock',
	'Goliad',
	'Gonzales',
	'Gray',
	'Grayson',
	'Gregg',
	'Grimes',
	'Guadalupe',
	'Hale',
	'Hall',
	'Hamilton',
	'Hansford',
	'Hardeman',
	'Hardin',
	'Harris',
	'Harrison',
	'Hartley',
	'Haskell',
	'Hays',
	'Hemphill',
	'Henderson',
	'Hidalgo',
	'Hill',
	'Hockley',
	'Hood',
	'Hopkins',
	'Houston',
	'Howard',
	'Hudspeth',
	'Hunt',
	'Hutchinson',
	'Irion',
	'Jack',
	'Jackson',
	'Jasper',
	'Jeff Davis',
	'Jefferson',
	'Jim Hogg',
	'Jim Wells',
	'Johnson',
	'Jones',
	'Karnes',
	'Kaufman',
	'Kendall',
	'Kenedy',
	'Kent',
	'Kerr',
	'Kimble',
	'King',
	'Kinney',
	'Kleberg',
	'Knox',
	'Lamar',
	'Lamb',
	'Lampasas',
	'La Salle',
	'Lavaca',
	'Lee',
	'Leon',
	'Liberty',
	'Limestone',
	'Lipscomb',
	'Live Oak',
	'Llano',
	'Loving',
	'Lubbock',
	'Lynn',
	'Madison',
	'Marion',
	'Martin',
	'Mason',
	'Matagorda',
	'Maverick',
	'McCulloch',
	'McLennan',
	'McMullen',
	'Medina',
	'Menard',
	'Midland',
	'Milam',
	'Mills',
	'Mitchell',
	'Montague',
	'Montgomery',
	'Moore',
	'Morris',
	'Motley',
	'Nacogdoches',
	'Navarro',
	'Newton',
	'Nolan',
	'Nueces',
	'Ochiltree',
	'Oldham',
	'Orange',
	'Palo Pinto',
	'Panola',
	'Parker',
	'Parmer',
	'Pecos',
	'Polk',
	'Potter',
	'Presidio',
	'Rains',
	'Randall',
	'Reagan',
	'Real',
	'Red River',
	'Reeves',
	'Refugio',
	'Roberts',
	'Robertson',
	'Rockwall',
	'Runnels',
	'Rusk',
	'Sabine',
	'San Augustine',
	'San Jacinto',
	'San Patricio',
	'San Saba',
	'Schleicher',
	'Scurry',
	'Shackelford',
	'Shelby',
	'Sherman',
	'Smith',
	'Somervell',
	'Starr',
	'Stephens',
	'Sterling',
	'Stonewall',
	'Sutton',
	'Swisher',
	'Tarrant',
	'Taylor',
	'Terrell',
	'Terry',
	'Throckmorton',
	'Titus',
	'Tom Green',
	'Travis',
	'Trinity',
	'Tyler',
	'Upshur',
	'Upton',
	'Uvalde',
	'Val Verde',
	'Van Zandt',
	'Victoria',
	'Walker',
	'Waller',
	'Ward',
	'Washington',
	'Webb',
	'Wharton',
	'Wheeler',
	'Wichita',
	'Wilbarger',
	'Willacy',
	'Williamson',
	'Wilson',
	'Winkler',
	'Wise',
	'Wood',
	'Yoakum',
	'Young',
	'Zapata',
	'Zavala',
];

// Confirmed-working, free, no-auth sources (verified 2026-07-29). Add more
// here as new CADs/cities are confirmed - see the research notes referenced
// in the PR/session for candidates still needing verification.
const SOURCES: Source[] = [
	{
		kind: 'socrata',
		id: 'travis-austin-land-database-2021',
		county: 'Travis',
		domain: 'data.austintexas.gov',
		resourceId: 'kk8y-6cmt',
		// Drop the heavy `the_geom` polygon column - we only need the tabular
		// ownership/valuation fields for the property index.
		select: 'objectid,prop_id,owner,situs,legal_desc,land_hstd_,land_non_h,imprv_hstd,imprv_non_,assessed_v,market_val,appraised_,yr_built,deed_dt,land_use,lu_desc,entities',
	},
	{
		kind: 'socrata',
		id: 'collin-cad-appraisal-2025',
		county: 'Collin',
		domain: 'data.texas.gov',
		resourceId: 'vffy-snc6',
		select:
			'propyear,propid,geoid,proptype,propsubtype,legaldescription,situsbldgnum,situsstreetname,situsstreetsuffix,situscity,situszip,situsconcat,ownername,ownernameaddtl,owneraddrline1,owneraddrcity,owneraddrstate,owneraddrzip,deedtypecd,deednum,deedeffdate,currvalland,currvalimprv,currvalmarket,currvalappraised,currvalassessed,exemptcodes',
	},
	{
		kind: 'cad-zip',
		id: 'tarrant-cad-property-data',
		county: 'Tarrant',
		zipUrl: 'https://www.tad.org/content/data-download/PropertyData(Delimited).ZIP',
		delimiter: '|',
		headers: { 'User-Agent': 'Mozilla/5.0' },
	},
	{
		kind: 'cad-zip',
		id: 'harris-cad-real-acct',
		county: 'Harris',
		zipUrl: 'https://download.hcad.org/data/CAMA/2026/Real_acct_owner.zip',
		innerFile: 'real_acct.txt',
		delimiter: '\t',
		headers: { 'User-Agent': 'Mozilla/5.0' },
	},
	{
		kind: 'cad-zip',
		id: 'fortbend-cad-property',
		county: 'Fort Bend',
		zipUrl: 'https://www.fbcad.org/wp-content/uploads/2024/07/2024_07_29_2001-Orion-2024-Certified-Export-REDACTED.zip',
		innerFile: '2024_07_29_2001_PropertyExport.txt',
		delimiter: ',',
		csv: true,
		headers: { 'User-Agent': 'Mozilla/5.0' },
	},
	{
		kind: 'cad-zip',
		id: 'fortbend-cad-owners',
		county: 'Fort Bend',
		zipUrl: 'https://www.fbcad.org/wp-content/uploads/2024/07/2024_07_29_2001-Orion-2024-Certified-Export-REDACTED.zip',
		innerFile: '2024_07_29_2001_OwnerExport.txt',
		delimiter: ',',
		csv: true,
		headers: { 'User-Agent': 'Mozilla/5.0' },
	},
	{
		kind: 'cad-zip',
		id: 'bell-cad-nal',
		county: 'Bell',
		zipUrl: 'https://bellcad.org/wp-content/uploads/2019/06/2026-Bell-County-Certified-Export-1.zip',
		innerFile: 'externalnal.tab',
		delimiter: '\t',
		headers: { 'User-Agent': 'Mozilla/5.0' },
	},
	{
		kind: 'arcgis',
		id: 'dallas-city-tax-parcels',
		county: 'Dallas',
		queryUrl: 'https://gis.dallascityhall.com/arcgis/rest/services/Basemap/DallasTaxParcels/MapServer/0/query',
		outFields: [
			'ACCT',
			'GIS_ACCT',
			'TAXPANAME1',
			'TAXPANAME2',
			'TAXPAADD1',
			'TAXPAADD2',
			'TAXPACITY',
			'TAXPASTA',
			'TAXPAZIP',
			'ST_NUM',
			'ST_NAME',
			'ST_TYPE',
			'ST_DIR',
			'CITY',
			'COUNTY',
			'LEGAL_1',
			'LEGAL_2',
			'PROP_CL',
			'BLDG_CL',
			'APPRAISALYEAR',
			'AREA_FEET',
		],
	},
];

function parseArgs() {
	const args = process.argv.slice(2);
	const only = args.find((a) => a.startsWith('--only='))?.split('=')[1];
	const force = args.includes('--force');
	return { only, force };
}

function slugifyCounty(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

async function main() {
	const { only, force } = parseArgs();
	const sources = only ? SOURCES.filter((s) => s.id === only) : SOURCES;

	if (sources.length === 0) {
		console.error(`No matching source for --only=${only}. Known ids: ${SOURCES.map((s) => s.id).join(', ')}`);
		process.exit(1);
	}

	console.log(`Ingesting ${sources.length} Texas bulk parcel source(s) -> ${OUT_DIR}/<county>/`);
	console.log(`Texas county manifest has ${TEXAS_COUNTIES.length} counties.`);

	for (const county of TEXAS_COUNTIES) {
		mkdirSync(path.join(OUT_DIR, slugifyCounty(county)), { recursive: true });
	}

	for (const source of sources) {
		const countyDir = path.join(OUT_DIR, slugifyCounty(source.county));
		const outFile = path.join(countyDir, `${source.id}.jsonl`);
		const checkpointFile = path.join(countyDir, `${source.id}.checkpoint.json`);
		if (!force && existsSync(outFile) && !existsSync(checkpointFile)) {
			// File exists with no checkpoint => a prior run completed fully.
			console.log(`[${source.id}] Already complete (no checkpoint present). Use --force to re-download.`);
			continue;
		}

		console.log(`\n=== ${source.county} County: ${source.id} (${source.kind}) ===`);
		try {
			if (source.kind === 'arcgis') {
				await downloadArcgisLayer(source, countyDir);
			} else if (source.kind === 'socrata') {
				await downloadSocrataDataset(source, countyDir);
			} else {
				await downloadCadZipSource(source, countyDir);
			}
		} catch (err) {
			console.error(`[${source.id}] Fatal error:`, (err as Error).message);
		}
	}

	console.log('\nAll configured sources processed.');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
