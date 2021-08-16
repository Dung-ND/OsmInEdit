/*
 * This file is part of OsmInEdit, released under ISC license (see LICENSE.md)
 *
 * Copyright (c) Adrien Pavie 2019
 * Copyright (c) Daimler AG 2019
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 */

import React, { Component } from 'react';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import 'leaflet-hash';
import { Map, TileLayer, WMSTileLayer, AttributionControl, ScaleControl } from 'react-leaflet';
import { BingLayer } from 'react-leaflet-bing';
import Body from './Body';
import Building from './layers/Building';
import Features from './layers/Features';
import FloorImagery from './layers/FloorImagery';
import I18n from '../config/locales/ui';
import Levels from './layers/Levels';
import LevelSelector from './common/LevelSelector';
import MapStyler from '../model/mapcss/MapStyler';
import NorthPointer from './common/NorthPointer';
import PACKAGE from '../../package.json';
import PubSub from 'pubsub-js';
import SidePanelButton from './common/SidePanelButton';
import Spinner from 'react-bootstrap/Spinner';

const MAP_MAX_ZOOM = 26;

/*
 * Extend leaflet hash for handling level value
 */

L.Hash.parseHash = function(hash) {
	if(hash.indexOf('#') === 0) {
		hash = hash.substr(1);
	}
	var args = hash.split("/");
	if (args.length >= 3 && args.length <= 4) {
		var zoom = parseInt(args[0], 10),
		lat = parseFloat(args[1]),
		lon = parseFloat(args[2]),
		level = args.length === 4 ? parseInt(args[3], 10) : 0;

		if (isNaN(zoom) || isNaN(lat) || isNaN(lon)) {
			return false;
		} else {
			return {
				center: new L.LatLng(lat, lon),
				zoom: zoom,
				level: isNaN(level) ? 0 : level
			};
		}
	} else {
		return false;
	}
};
L.Hash.prototype.parseHash = L.Hash.parseHash;

L.Hash.formatHash = function(map) {
	var center = map.getCenter(),
		zoom = map.getZoom(),
		precision = Math.max(0, Math.ceil(Math.log(zoom) / Math.LN2));

	return "#" + [zoom,
		center.lat.toFixed(precision),
		center.lng.toFixed(precision),
		this._level || "0"
	].join("/");
};
L.Hash.prototype.formatHash = L.Hash.formatHash;

L.Hash.prototype.setLevel = function(lvl) {
	if(this._level !== lvl) {
		this._level = lvl;
		var hash = this.formatHash(this.map);
		window.location.replace(hash);
		this.lastHash = hash;
	}
};

L.Hash.prototype.update = function() {
	var hash = window.location.hash;
	if (hash === this.lastHash) {
		return;
	}
	var parsed = this.parseHash(hash);
	if (parsed) {
		this.movingMap = true;
		this.map.setView(parsed.center, parsed.zoom);
		this.movingMap = false;
		PubSub.publish("body.level.set", { level: parsed.level });
	} else {
		this.onMapMove(this.map);
	}
};


/**
 * Map component handles the whole map and associated widgets.
 */
class MyMap extends Component {
	constructor() {
		super();

		this.state = {
			loading: false,
			dataready: false
		};

		this.mapStyler = new MapStyler();
		this.loadedArea = null;
	}

	/**
	 * Alert this component that its size has changed
	 */
	invalidateSize() {
		if(this.elem && this.elem.leafletElement) {
			this.elem.leafletElement.invalidateSize();
		}
	}

	/**
	 * Clean up map after changeset upload
	 */
	cleanUp() {
		this.loadedArea = null;
		this.setState({ loading: false, dataready: false });
	}

	/**
	 * Get the coordinates of map center
	 * @return {LatLng} Coordinates of map center (or null if not ready)
	 */
	getCenter() {
		return (this.elem && this.elem.leafletElement) ? this.elem.leafletElement.getCenter() : null;
	}

	/**
	 * Get the bounding box of currently shown area on map
	 * @return {LatLngBounds} Bounding box of the map
	 */
	getBounds() {
		return (this.elem && this.elem.leafletElement) ? this.elem.leafletElement.getBounds() : null;
	}

	/**
	 * Is the map currently loading data ?
	 * @return {boolean} True if loading
	 */
	isLoading() {
		return this.state.loading;
	}

	/**
	 * Event handler when map moves
	 * @private
	 */
	async _loadData(bounds) {
		if(this.props.datalocked || (window.CONFIG.always_authenticated && !window.editor_user)) {
			return new Promise(resolve => {
				setTimeout(() => resolve(this._loadData(bounds)), 100);
			});
		}
		else if(!this.props.draw && this.getBounds() && this.elem.leafletElement.getZoom() >= window.CONFIG.data_min_zoom) {
			let bbox = bounds || this.getBounds();

			// Only load data if bbox is valid and not in an already downloaded area
			if(
				bbox
				&& bbox.getSouth() !== bbox.getNorth()
				&& bbox.getWest() !== bbox.getEast()
				&& (!this.loadedArea || !this.loadedArea.contains(bbox))
			) {
				// Augment bbox size if too small (to avoid many data reloads)
				while(bbox.getSouthWest().distanceTo(bbox.getNorthEast()) < 400) {
					bbox = bbox.pad(0.1);
				}

				this.loadedArea = bbox;
				this.setState(
					{ loading: true },
					async () => {
						try {
							const result = await window.vectorDataManager.loadOSMData(bbox);
							this.setState({ loading: false, dataready: result });
						}
						catch(e) {
							alert(I18n.t("Can't download data from OSM server. Please retry later."));
							this.setState({ loading: false, dataready: false });
						}
					}
				);
			}
		}
	}

	/**
	 * Generate layer from given configuration
	 * @private
	 */
	_getLayer(l, opacity) {
		if(!l || !l.properties || !l.properties.url) {
			return null;
		}

		if(l.properties.type === "tms") {
			const url = l.properties.url
				.replace(/\{zoom\}/g, "{z}")
				.replace(/\{switch:.+?\}/g, "{s}")
				.replace(/\{-y\}/g, "{y}");

			return <TileLayer
				attribution={l.properties.attribution ? '<a href="'+l.properties.attribution.url+'" target="_blank">'+l.properties.attribution.text+'</a>' : ''}
				url={url}
				key={url}
				minZoom={l.properties.min_zoom}
				maxNativeZoom={l.properties.max_zoom}
				maxZoom={MAP_MAX_ZOOM}
				opacity={opacity}
				tms={l.properties.url.indexOf("{-y}") > 0}
			/>;
		}
		else if(l.properties.type === "wms") {
			let url = l.properties.url;
			const params = {};
			const urlParts = l.properties.url.split('?');

			if(urlParts.length > 1) {
				url = urlParts[0];
				const blacklist = ['srs', 'width', 'height', 'format', 'service', 'request', 'bbox', 'key', 'crs'];

				urlParts[1].split('&').forEach(p => {
					const [k,v] = p.split('=');
					if(!blacklist.includes(k.toLowerCase())) {
						params[k.toLowerCase()] = v;
					}
					else if(['key'].includes(k.toLowerCase())) {
						params[k.toUpperCase()] = v;
					}
				});
			}

			return <WMSTileLayer
				attribution={l.properties.attribution ? '<a href="'+l.properties.attribution.url+'" target="_blank">'+l.properties.attribution.text+'</a>' : ''}
				url={url}
				key={l.properties.url}
				opacity={opacity}
				{...params}
			/>;
		}
		else if(l.properties.type === "bing" && window.CONFIG.providers && window.CONFIG.providers.bing) {
			return <BingLayer
				bingkey={window.CONFIG.providers.bing}
				type="Aerial"
				maxNativeZoom={20}
				maxZoom={MAP_MAX_ZOOM}
			/>;
		}
		else {
			return null;
		}
	}

	/**
	 * Converts floor imagery info into a Leaflet layer.
	 * @private
	 */
	_getFloorMapLayer(floormap) {
		if(!floormap || !floormap.topleft) {
			return null;
		}
		else {
			return <FloorImagery
				data={floormap}
				key={floormap.id}
				opacity={floormap.opacity !== undefined && !isNaN(parseFloat(floormap.opacity)) ? floormap.opacity : 1}
				ref={"floormap_"+floormap.id}
				level={this.props.level}
				mode={this.props.mode}
				tool={this.props.floorImageryMode}
			/>;
		}
	}

	render() {
		const floorImgs = window.imageryManager.getFloorImages();
		let levelsList = null;

		if(this.props.mode === Body.MODE_EXPLORE) {
			levelsList = window.vectorDataManager.getAllLevels(true);
		}
		else if(this.props.mode === Body.MODE_BUILDING) {
			if(this.props.building) {
				levelsList = this.props.building.properties.own.levels.slice(0);
				levelsList.sort();
			}
			else {
				levelsList = window.vectorDataManager.getAllLevels(false);
			}
		}
		else if([ Body.MODE_LEVELS, Body.MODE_FEATURES ].includes(this.props.mode) && this.props.building) {
			levelsList = this.props.building.properties.own.levels.slice(0);
			levelsList.sort();
		}

		return <div className="app-map-container">
			{(this.props.mode === Body.MODE_CHANGESET || this.state.loading) &&
				<div style={{
					zIndex: 20000,
					background: "rgba(0,0,0,0.5)",
					position: "absolute",
					top: 0, right: 0, left: 0, bottom: 0,
					textAlign: "center", display: "flex", alignItems: "center"
				}}>
					{this.state.loading &&
						<Spinner
							animation="grow"
							variant="light"
							size="lg"
							style={{ margin: "auto", width: "5rem", height: "5rem" }}
						/>
					}
				</div>
			}
			<Map
				maxZoom={MAP_MAX_ZOOM}
				className={"app-map"+(this.props.draw ? " leaflet-clickable" : "")}
				ref={elem => this.elem = elem}
				preferCanvas={false}
				editable={true}
				scrollWheelZoom={true}
				doubleClickZoom={this.props.mode === Body.MODE_EXPLORE}
				attributionControl={false}
				boxSelector={false}
				boxZoom={false}
			>
				<AttributionControl
					prefix={"<a href='https://framagit.org/PanierAvide/osminedit' target='_blank'>"+window.EDITOR_NAME+"</a> v"+PACKAGE.version+" "+(window.CONFIG.hash === "GIT_HASH" ? "dev" : window.CONFIG.hash)}
				/>

				<ScaleControl
					position="bottomleft"
					imperial={false}
				/>

				<NorthPointer
					position="bottomright"
				/>

				<SidePanelButton
					position="topright"
				/>

				{[Body.MODE_EXPLORE, Body.MODE_BUILDING, Body.MODE_LEVELS, Body.MODE_FEATURES].includes(this.props.mode) && !this.state.loading && this.state.dataready && levelsList &&
					<LevelSelector
						position="topright"
						levels={levelsList}
						level={this.props.level}
					/>
				}

				{this.props.selectedBaseImagery && this._getLayer(this.props.selectedBaseImagery, this.props.baseImageryOpacity)}

				{this.props.selectedOverlaysImagery && this.props.selectedOverlaysImagery.map(ol => this._getLayer(ol, this.props.overlaysImageryOpacity))}

				{this.props.mode !== Body.MODE_EXPLORE && floorImgs && floorImgs.map(fi => this._getFloorMapLayer(fi))}

				{!this.state.loading && this.state.dataready && [Body.MODE_BUILDING, Body.MODE_FLOOR_IMAGERY].includes(this.props.mode) &&
					<Building
						styler={this.mapStyler}
						building={this.props.building}
						draw={this.props.draw}
						level={this.props.level}
						locked={this.props.mode === Body.MODE_FLOOR_IMAGERY}
					/>
				}

				{!this.state.loading && this.state.dataready && this.props.mode === Body.MODE_LEVELS && this.props.building &&
					<Levels
						styler={this.mapStyler}
						level={this.props.level}
						building={this.props.building}
						floor={this.props.floor}
						draw={this.props.draw}
					/>
				}

				{!this.state.loading && this.state.dataready && (this.props.mode === Body.MODE_EXPLORE || (this.props.mode === Body.MODE_FEATURES && this.props.building)) &&
					<Features
						styler={this.mapStyler}
						level={this.props.level}
						building={this.props.building}
						feature={this.props.feature}
						draw={this.props.draw}
						locked={this.props.mode === Body.MODE_EXPLORE}
					/>
				}
			</Map>
		</div>;
	}

	/**
	 * @private
	 */
	_followMouse(e) {
		this._mouseCoords = e.latlng;
	}

	componentDidMount() {
		setTimeout(() => {
			this.invalidateSize();
			this._loadData();
		}, 500);

		// URL hash for map
		this._mapHash = new L.Hash(this.elem.leafletElement);

		// If no valid hash found, use default coordinates from config file or stored cookie
		if(!window.location.hash || !window.location.hash.match(/^#\d+\/-?\d+(.\d+)?\/-?\d+(.\d+)?(\/(-?\d+(.\d+)?)?)?$/)) {
			// Has cookie ?
			const cookieHash = document.cookie.replace(/(?:(?:^|.*;\s*)lasthash\s*=\s*([^;]*).*$)|^.*$/, "$1");
			let newHash;

			if(cookieHash && L.Hash.parseHash(cookieHash)) {
				newHash = cookieHash;
			}
			else {
				newHash = "#"+window.CONFIG.map_initial_zoom+"/"+window.CONFIG.map_initial_latlng.join("/");
			}

			window.history.pushState({}, "", window.location.href.split("#")[0] + newHash);
		}

		L.DomEvent.addListener(window, "hashchange", () => {
			document.cookie = "lasthash="+window.location.hash;
		});

		this.elem.leafletElement.on("dblclick", e => {
			if(!this.props.draw && this.props.mode !== Body.MODE_EXPLORE) {
				PubSub.publish("body.unselect.feature");
			}
		});

		this.elem.leafletElement.on("zoomend moveend", () => {
			if(this.elem && this.elem.leafletElement) {
				this._loadData();

				const zoom = this.elem.leafletElement.getZoom();

				if(zoom < window.CONFIG.data_min_zoom && (!this._lastZoom || this._lastZoom >= window.CONFIG.data_min_zoom)) {
					this.elem.container.classList.add("app-map-novector");
					PubSub.publishSync("body.unselect.feature");
// 					PubSub.publish("body.mode.set", { mode: Body.MODE_BUILDING });
				}
				else if(zoom >= window.CONFIG.data_min_zoom && (!this._lastZoom || this._lastZoom < window.CONFIG.data_min_zoom)) {
					this.elem.container.classList.remove("app-map-novector");
				}

				this._lastZoom = zoom;
			}
		});

		// Follow mouse position
		this.elem.leafletElement.on("mousemove", this._followMouse, this);

		/**
		 * Event for map zoom changes
		 * @event map.zoom.changed
		 * @memberof MyMap
		 * @property {int} zoom The new zoom level
		 */
		const alertZoom = () => {
			if(this.elem && this.elem.leafletElement) {
				PubSub.publish("map.zoom.changed", { zoom: this.elem.leafletElement.getZoom() });
			}
		};
		this.elem.leafletElement.on("zoomend", alertZoom);
		alertZoom();

		/**
		 * Event for changing current map position
		 * @event map.position.set
		 * @memberof MyMap
		 * @property {LatLng} coordinates The new position
		 * @property {int} [zoom] The zoom level
		 */
		PubSub.subscribe("map.position.set", (msg, data) => {
			if(data.bbox) {
				const [minlat, maxlat, minlon, maxlon] = data.bbox;
				this.elem.leafletElement.fitBounds([[minlat, minlon], [maxlat, maxlon]]);
			}
			else if(data.zoom) {
				this.elem.leafletElement.setView(data.coordinates, data.zoom);
			}
			else {
				this.elem.leafletElement.panTo(data.coordinates);
			}
		});
	}

	componentDidUpdate(fromProps) {
		if(this.props.level !== fromProps.level) {
			this._mapHash.setLevel(this.props.level);
		}

		const floorImgs = window.imageryManager.getFloorImages();

		// Force update of floor imagery after mode change
		if(fromProps.mode !== this.props.mode) {
			this.invalidateSize();

			floorImgs.forEach(img => {
				// Check if we have a leaflet layer
				if(this.refs["floormap_"+img.id]) {
					this.refs["floormap_"+img.id].forceUpdate();
				}
			});
		}

		// Follow mouse position
		this.elem.leafletElement.off("mousemove", this._followMouse, this);
		this.elem.leafletElement.on("mousemove", this._followMouse, this);

		// Load wider area if necessary
		if(!this.props.draw && !this.state.loading && this.elem.leafletElement.getZoom() > 19) {
			this._loadData(this.getBounds().pad(0.5*(this.elem.leafletElement.getZoom()-19)));
		}
	}

	componentWillUnmount() {
		PubSub.unsubscribe("map");
		this.elem.leafletElement.off("mousemove", this._followMouse, this);
		this.elem.leafletElement.off("load");
		this.elem.leafletElement.off("zoomend");
		this.elem.leafletElement.off("moveend");
		this.elem.leafletElement.off("dblclick");
	}
}

export default MyMap;
