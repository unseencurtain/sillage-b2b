<?php
/**
 * Shared configuration and helpers.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Configuration the plugin needs at runtime.
 *
 * There is no settings screen. Everything operational lives in the sillage-core dashboard; the
 * only things WordPress needs to know are the shared secret and where the dashboard is, both of
 * which come from wp-config.php constants so they never sit in the database.
 */
final class Sillage_Settings {

	/**
	 * HMAC secret shared with sillage-core.
	 *
	 * Falls back to an option so the plugin can be activated before wp-config is edited, but the
	 * constant is the intended source.
	 */
	public static function shared_secret(): string {
		if ( defined( 'SILLAGE_SHARED_SECRET' ) && is_string( SILLAGE_SHARED_SECRET ) ) {
			return SILLAGE_SHARED_SECRET;
		}
		$stored = get_option( 'sillage_shared_secret', '' );
		return is_string( $stored ) ? $stored : '';
	}

	/** Base URL of sillage-core, reachable from inside the WordPress container. */
	public static function core_url(): string {
		if ( defined( 'SILLAGE_CORE_URL' ) && is_string( SILLAGE_CORE_URL ) ) {
			return rtrim( SILLAGE_CORE_URL, '/' );
		}
		return 'http://sillage-core:4000';
	}

	/** Dashboard URL for a human, which is published on loopback rather than the docker network. */
	public static function dashboard_url(): string {
		if ( defined( 'SILLAGE_DASHBOARD_URL' ) && is_string( SILLAGE_DASHBOARD_URL ) ) {
			return rtrim( SILLAGE_DASHBOARD_URL, '/' );
		}
		return 'http://127.0.0.1:4000';
	}

	/**
	 * Verify an inbound HMAC signature in constant time.
	 *
	 * @param string      $body      Raw request body.
	 * @param string|null $signature Value of the X-Sillage-Signature header.
	 */
	public static function verify_signature( string $body, ?string $signature ): bool {
		$secret = self::shared_secret();
		if ( '' === $secret || null === $signature || '' === $signature ) {
			return false;
		}
		$expected = 'sha256=' . hash_hmac( 'sha256', $body, $secret );
		return hash_equals( $expected, $signature );
	}

	/** Sign an outbound payload the same way sillage-core does. */
	public static function sign( string $body ): string {
		return 'sha256=' . hash_hmac( 'sha256', $body, self::shared_secret() );
	}

	/**
	 * Whether the sillage schema is readable.
	 *
	 * WordPress connects as a user granted SELECT on a small set of sillage tables, so a missing
	 * grant is a realistic misconfiguration worth surfacing rather than a fatal error.
	 */
	public static function ean_index_available(): bool {
		$cached = wp_cache_get( 'ean_index_available', 'sillage' );
		if ( false !== $cached ) {
			return (bool) $cached;
		}

		global $wpdb;
		$suppress = $wpdb->suppress_errors( true );
		$table    = SILLAGE_DB . '.sil_ean_index';
		// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared -- table name is a constant, not input.
		$result = $wpdb->get_var( "SELECT 1 FROM {$table} LIMIT 1" );
		$ok     = ( null === $wpdb->last_error || '' === $wpdb->last_error );
		$wpdb->suppress_errors( $suppress );

		unset( $result );
		wp_cache_set( 'ean_index_available', $ok ? 1 : 0, 'sillage', 300 );
		return $ok;
	}
}
