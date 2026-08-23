import fs from 'fs';

let content = fs.readFileSync('src/components/panel/LocalNameSearch.tsx', 'utf8');

const target = `<div className='local-name-search-panel'>
			<div className='local-name-search-header'>
				<h3>
					Redis Search
					{searched && !loading && !error && <span className='local-name-search-count'> ({resultCount.toLocaleString()})</span>}
				</h3>
			</div>

			<div className='row'>
				<input
					type='text'
					className='local-name-search-input'
					style={{ flex: 1, minWidth: 0 }}
					placeholder='Search Redis-saved records by name…'
					value={query}
					onChange={(e) => onQueryChange(e.target.value)}
					onKeyDown={handleKeyDown}
					spellCheck={false}
				/>
				<button
					className={\`button-secondary local-name-search-button\${loading ? ' is-loading' : ''}\`}
					onClick={() => onSearch()}
					disabled={loading || !query.trim()}
					aria-busy={loading}>
					<span className='local-name-search-button-label'>{loading ? 'Fetching…' : 'Search'}</span>
				</button>
			</div>

			<div
				className='local-name-search-filters'
				style={{ display: 'flex', gap: '15px', padding: '10px 0', fontSize: '13px', alignItems: 'center' }}>
				<label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
					<input
						type='checkbox'
						defaultChecked
					/>{' '}
					Firm
				</label>
				<label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
					<input
						type='checkbox'
						defaultChecked
					/>{' '}
					Person
				</label>
				<label style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '10px' }}>
					Zip Code:{' '}
					<input
						type='text'
						placeholder='Zip'
						style={{ width: '60px', padding: '2px 4px', fontSize: '12px' }}
					/>
				</label>
				<label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
					Radius:
					<select style={{ padding: '2px 4px', fontSize: '12px' }}>
						<option value='10'>10 mi</option>
						<option value='25'>25 mi</option>
						<option value='50'>50 mi</option>
						<option value='100'>100 mi</option>
					</select>
				</label>
				<div className='local-name-search-status-row' style={{ marginLeft: 'auto' }}>
					<a
						href='/api/redis-health'
						target='_blank'
						rel='noopener noreferrer'
						className={redisBadgeClass}
						title={\`\${redisBadgeTitle} • Open health details\`}
						aria-label='Open Redis health details'>
						{redisBadgeText}
					</a>
				</div>
			</div>`;

const replacement = `<div className='local-name-search-panel'>
			<div className='local-name-search-header-row' style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap' }}>
				<h3 style={{ margin: 0, whiteSpace: 'nowrap' }}>
					Redis Search
					{searched && !loading && !error && <span className='local-name-search-count'> ({resultCount.toLocaleString()})</span>}
				</h3>

				<div className='row' style={{ flex: 1, minWidth: '300px', margin: 0 }}>
					<input
						type='text'
						className='local-name-search-input'
						style={{ flex: 1, minWidth: 0, height: '32px' }}
						placeholder='Search Redis-saved records by name…'
						value={query}
						onChange={(e) => onQueryChange(e.target.value)}
						onKeyDown={handleKeyDown}
						spellCheck={false}
					/>
					<button
						className={\`button-secondary local-name-search-button\${loading ? ' is-loading' : ''}\`}
						onClick={() => onSearch()}
						disabled={loading || !query.trim()}
						aria-busy={loading}
						style={{ height: '32px', minWidth: '90px' }}>
						<span className='local-name-search-button-label'>{loading ? 'Fetching…' : 'Search'}</span>
					</button>
				</div>

				<div
					className='local-name-search-filters'
					style={{ display: 'flex', gap: '15px', fontSize: '13px', alignItems: 'center' }}>
					<label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
						<input type='checkbox' defaultChecked /> Firm
					</label>
					<label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
						<input type='checkbox' defaultChecked /> Person
					</label>
					<label style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '5px' }}>
						Zip:{' '}
						<input
							type='text'
							placeholder='Zip'
							style={{ width: '50px', padding: '2px 4px', fontSize: '12px' }}
						/>
					</label>
					<label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
						Radius:
						<select style={{ padding: '2px 4px', fontSize: '12px' }}>
							<option value='10'>10 mi</option>
							<option value='25'>25 mi</option>
							<option value='50'>50 mi</option>
							<option value='100'>100 mi</option>
						</select>
					</label>
					<div className='local-name-search-status-row' style={{ marginLeft: 'auto' }}>
						<a
							href='/api/redis-health'
							target='_blank'
							rel='noopener noreferrer'
							className={redisBadgeClass}
							title={\`\${redisBadgeTitle} • Open health details\`}
							aria-label='Open Redis health details'>
							{redisBadgeText}
						</a>
					</div>
				</div>
			</div>`;

if (content.includes("<div className='local-name-search-header'>")) {
    const startIndex = content.indexOf("<div className='local-name-search-panel'>\n\t\t\t<div className='local-name-search-header'>");
    const endIndex = content.indexOf("</div>\n\t\t\t</div>", startIndex) + 14;
    // Actually regex replace might be safer
}

